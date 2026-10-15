import { execFile, spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { eq, sql } from "drizzle-orm";
import { readMigrationFiles, type MigrationConfig } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pino from "pino";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  startBarePostgresTestDb,
  startMainAndBrainPostgresTestDb,
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "../pg-container";
import { migrateTestDatabase } from "../migrate-test-database";
import {
  assertInvocationGroupEmpty,
  createInvocation,
  fixtureProcessEnvironment,
  FIXTURE_WATCHDOG,
  logInvocation,
  registerSpawnedProcess,
  releaseInvocation,
  signalInvocationProcess,
  type ProcessIdentity,
} from "../process-invocation";

const databases: StartedPostgresTestDb[] = [];
const migrationLogger = pino({ name: "test-migration-qualification" });

type AdminSeed = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: "admin" | "member" | "viewer";
  must_change_password: boolean;
};

async function migrationCatalog(
  pool: Pool,
): Promise<readonly { definition: string }[]> {
  const result = await pool.query<{ definition: string }>(`
    WITH namespaces AS (
      SELECT oid FROM pg_namespace
      WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
    ), objects AS (
      SELECT jsonb_build_object('kind', 'relation', 'schema', n.nspname,
        'name', c.relname, 'type', c.relkind, 'persistence', c.relpersistence,
        'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
        'options', c.reloptions) AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.oid IN (SELECT oid FROM namespaces) AND c.relkind IN ('r','p','v','m','S')
      UNION ALL
      SELECT jsonb_build_object('kind', 'column', 'schema', n.nspname,
        'relation', c.relname, 'name', a.attname, 'position', a.attnum,
        'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
        'identity', a.attidentity, 'generated', a.attgenerated,
        'default', pg_get_expr(d.adbin, d.adrelid))
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.oid IN (SELECT oid FROM namespaces) AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT jsonb_build_object('kind', 'constraint', 'schema', n.nspname,
        'relation', c.relname, 'name', k.conname, 'definition', pg_get_constraintdef(k.oid))
      FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
      LEFT JOIN pg_class c ON c.oid = k.conrelid
      WHERE n.oid IN (SELECT oid FROM namespaces)
      UNION ALL
      SELECT jsonb_build_object('kind', 'index', 'schema', n.nspname,
        'name', c.relname, 'definition', pg_get_indexdef(c.oid))
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.oid IN (SELECT oid FROM namespaces) AND c.relkind IN ('i','I')
      UNION ALL
      SELECT jsonb_build_object('kind', 'enum', 'schema', n.nspname,
        'name', t.typname, 'position', e.enumsortorder, 'label', e.enumlabel)
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.oid IN (SELECT oid FROM namespaces)
      UNION ALL
      SELECT jsonb_build_object('kind', 'function', 'schema', n.nspname,
        'name', p.proname, 'definition', pg_get_functiondef(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.oid IN (SELECT oid FROM namespaces) AND p.prokind IN ('f','p')
      UNION ALL
      SELECT jsonb_build_object('kind', 'trigger', 'schema', n.nspname,
        'relation', c.relname, 'name', t.tgname, 'definition', pg_get_triggerdef(t.oid))
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.oid IN (SELECT oid FROM namespaces) AND NOT t.tgisinternal
      UNION ALL
      SELECT jsonb_build_object('kind', 'sequence', 'schema', n.nspname,
        'name', c.relname, 'start', s.seqstart, 'increment', s.seqincrement,
        'max', s.seqmax, 'min', s.seqmin, 'cache', s.seqcache, 'cycle', s.seqcycle)
      FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.oid IN (SELECT oid FROM namespaces)
      UNION ALL
      SELECT jsonb_build_object('kind', 'view', 'schema', n.nspname,
        'name', c.relname, 'definition', pg_get_viewdef(c.oid))
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.oid IN (SELECT oid FROM namespaces) AND c.relkind IN ('v','m')
    )
    SELECT definition::text AS definition FROM objects ORDER BY definition::text
  `);

  return result.rows;
}

async function migrationLedger(
  pool: Pool,
  table: "__drizzle_migrations" | "__drizzle_brain_migrations",
): Promise<readonly { hash: string; created_at: string }[]> {
  const ledger =
    table === "__drizzle_brain_migrations"
      ? "drizzle.__drizzle_brain_migrations"
      : "drizzle.__drizzle_migrations";
  const result = await pool.query<{ hash: string; created_at: string }>(
    `SELECT hash, created_at FROM ${ledger} ORDER BY id`,
  );

  return result.rows;
}

afterAll(async () => {
  for (const database of databases.reverse()) {
    await database.stop();
  }
});

async function runRealDockerDiscovery(
  delayMs: number,
): Promise<Readonly<{ outcome: unknown; records: readonly unknown[] }>> {
  const directory = await mkdtemp(join(tmpdir(), "maister-docker-discovery-"));
  const invocation = await createInvocation(directory);
  const evidence = join(directory, "compose.jsonl");
  const wrapper = join(directory, "docker");
  const { stdout: dockerPath } = await promisify(execFile)("which", ["docker"]);

  await copyFile(
    fileURLToPath(
      new URL("./fixtures/docker-compose-delay.mjs", import.meta.url),
    ),
    wrapper,
  );
  await chmod(wrapper, 0o700);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./scripts/_register-shim.mjs",
      "--import",
      FIXTURE_WATCHDOG,
      fileURLToPath(
        new URL("./fixtures/docker-probe-child.ts", import.meta.url),
      ),
    ],
    {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        ...(await fixtureProcessEnvironment(invocation)),
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        MAISTER_TEST_DOCKER_PROBE_TIMEOUT_MS: "3000",
        MAISTER_DOCKER_CONTROL_BINARY: dockerPath.trim(),
        MAISTER_DOCKER_CONTROL_EVIDENCE: evidence,
        MAISTER_DOCKER_CONTROL_DELAY_MS: String(delayMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const capture = (chunk: Buffer): void => {
    output = `${output}${chunk.toString()}`.slice(-64 * 1024);
  };

  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const exited = new Promise<
    Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
  >((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  void exited.catch(() => {});
  let identity: ProcessIdentity | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let failure: unknown;
  let outcome: unknown;
  let records: unknown[] = [];

  try {
    identity = (
      await registerSpawnedProcess(
        invocation,
        {
          role: "fixture",
          caseName: "docker-compose-discovery",
          rootRole: "database",
          root: null,
          bootId: invocation.id,
          logFile: join(directory, "probe.log"),
        },
        child,
      )
    ).identity;
    expect(
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  "real Compose/Postgres discovery control exceeded its deadline",
                ),
              ),
            40_000,
          );
        }),
      ]),
      output,
    ).toEqual({ code: 0, signal: null });
    records = output
      .trim()
      .split("\n")
      .flatMap((line): unknown[] => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
    outcome = records.find(
      (record) =>
        typeof record === "object" &&
        record !== null &&
        "name" in record &&
        !("level" in record),
    );

    const discovery: unknown = JSON.parse(
      (await readFile(evidence, "utf8")).trim(),
    );

    expect(discovery).toMatchObject({ event: "real-compose-discovery" });
    expect((discovery as { delayMs: number }).delayMs).toBeGreaterThanOrEqual(
      delayMs,
    );
    logInvocation(invocation, "docker-discovery-control", {
      role: "fixture",
      caseName: "docker-compose-discovery",
      pid: process.pid,
      rootRole: "database",
      outcome: "observed",
      daemonDeadlineMs: 3_000,
      composeDelayMs: (discovery as { delayMs: number }).delayMs,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (timeout) clearTimeout(timeout);
    const cleanupErrors: unknown[] = [];

    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (identity)
          await signalInvocationProcess(invocation, identity, "SIGKILL");
        else child.kill("SIGKILL");
        await exited;
      }
      if (identity) await assertInvocationGroupEmpty(invocation, identity.pgid);
    } catch (error) {
      cleanupErrors.push(error);
    }
    cleanupErrors.push(
      ...(await releaseInvocation(invocation, "Docker discovery control")),
    );
    try {
      await writeFile(join(directory, "probe.log"), output);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length)
      failure = new AggregateError(
        failure ? [failure, ...cleanupErrors] : cleanupErrors,
        "real Docker discovery control cleanup failed",
      );
  }
  if (failure) throw failure;
  logInvocation(invocation, "docker-discovery-cleanup", {
    role: "fixture",
    caseName: "docker-compose-discovery",
    pid: process.pid,
    rootRole: "database",
    outcome: "clean",
    leaks: 0,
  });

  return { outcome, records };
}

describe("shared Testcontainers Postgres helper", () => {
  it("separates fast daemon contact from slow real Compose discovery", async () => {
    const result = await runRealDockerDiscovery(4_000);

    expect(result.outcome).toMatchObject({ name: "ready", value: 1 });
  });

  it("bounds full real SDK discovery after successful daemon contact", async () => {
    const result = await runRealDockerDiscovery(31_000);

    expect(result.outcome).toMatchObject({
      name: "TestDatabaseDockerUnavailableError",
      message: expect.stringContaining("client construction timed out"),
      durationMs: expect.any(Number),
    });
    const durationMs = (result.outcome as { durationMs: number }).durationMs;

    expect(durationMs).toBeGreaterThanOrEqual(30_000);
    expect(durationMs).toBeLessThan(31_000);
    expect(result.records).toContainEqual(
      expect.objectContaining({
        phase: "docker-daemon-contact",
        outcome: "passed",
      }),
    );
    expect(result.records).not.toContainEqual(
      expect.objectContaining({
        phase: "docker-client-construction",
        outcome: "passed",
      }),
    );
  });

  it("keeps the bare lineage free of migration ledgers", async () => {
    const database = await startBarePostgresTestDb({
      databaseName: "test_support_bare",
    });

    databases.push(database);

    const ledgers = await database.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'drizzle'`,
    );

    expect(ledgers.rows).toEqual([]);
    const directory = await database.pool.query<{ data_directory: string }>(
      "SHOW data_directory",
    );
    const filesystem = await database.container.exec([
      "stat",
      "-f",
      "-c",
      "%T %S %b",
      directory.rows[0].data_directory,
    ]);
    const [kind, blockSize, blocks] = filesystem.output.trim().split(/\s+/u);

    expect(filesystem.exitCode).toBe(0);
    expect(kind).toBe("tmpfs");
    expect(Number(blockSize) * Number(blocks)).toBe(512 * 1024 * 1024);
    const durability = await database.pool.query<{
      name: string;
      setting: string;
    }>(
      "SELECT name, setting FROM pg_settings WHERE name IN ('fsync', 'full_page_writes', 'max_wal_size', 'min_wal_size', 'synchronous_commit') ORDER BY name",
    );

    expect(durability.rows).toEqual([
      { name: "fsync", setting: "on" },
      { name: "full_page_writes", setting: "on" },
      { name: "max_wal_size", setting: "64" },
      { name: "min_wal_size", setting: "32" },
      { name: "synchronous_commit", setting: "on" },
    ]);
  });

  it("migrates the main lineage and preserves the requested pool limit", async () => {
    const database = await startMainPostgresTestDb({
      databaseName: "test_support_main",
      poolMax: 3,
    });

    databases.push(database);

    const mainLedger = await database.db.execute(
      sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
    );

    expect(Number(mainLedger.rows[0]?.count)).toBeGreaterThan(0);
    expect(database.pool.options.max).toBe(3);

    const seededAdmin = await database.db.query.users.findFirst({
      where: (users) => eq(users.email, "admin@maister.local"),
    });

    expect(seededAdmin?.email).toBe("admin@maister.local");
  });

  it("migrates Brain after the main lineage", async () => {
    const database = await startMainAndBrainPostgresTestDb({
      databaseName: "test_support_brain",
    });

    databases.push(database);

    const brainLedger = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM drizzle.__drizzle_brain_migrations`,
    );

    expect(Number(brainLedger.rows[0]?.count)).toBeGreaterThan(0);
  });

  it("batches complete migration files without changing schema, ledgers, seeds or rollback", async () => {
    const batched = await startBarePostgresTestDb({
      databaseName: "test_support_batched",
    });

    databases.push(batched);
    const standard = await startBarePostgresTestDb({
      databaseName: "test_support_standard",
    });

    databases.push(standard);
    const configs: readonly (MigrationConfig & {
      migrationsTable: "__drizzle_migrations" | "__drizzle_brain_migrations";
    })[] = [
      {
        migrationsFolder: "./lib/db/migrations",
        migrationsTable: "__drizzle_migrations",
      },
      {
        migrationsFolder: "./lib/db/brain-migrations",
        migrationsTable: "__drizzle_brain_migrations",
      },
    ];

    for (const config of configs) {
      let standardSubmissions = 0;
      const reference = drizzle(standard.pool, {
        logger: {
          logQuery(): void {
            standardSubmissions += 1;
          },
        },
      });

      const standardStartedAt = Date.now();

      await migrate(reference, config);
      const standardDurationMs = Date.now() - standardStartedAt;
      const receipt = await migrateTestDatabase(batched.pool, config);
      const source = readMigrationFiles(config);

      migrationLogger.info(
        {
          migrationsTable: config.migrationsTable,
          standardSubmissions,
          standardDurationMs,
          batchedSubmissions: receipt.querySubmissions,
          batchedDurationMs: receipt.durationMs,
        },
        "compared real PostgreSQL migration execution",
      );

      expect(receipt.querySubmissions).toBe(6);
      expect(receipt.querySubmissions).toBeLessThan(standardSubmissions);
      const ledger = config.migrationsTable ?? "__drizzle_migrations";
      const expected = source.map((entry) => ({
        hash: entry.hash,
        created_at: String(entry.folderMillis),
      }));

      expect(await migrationLedger(batched.pool, ledger)).toEqual(expected);
      expect(await migrationLedger(batched.pool, ledger)).toEqual(
        await migrationLedger(standard.pool, ledger),
      );
      expect(await migrationCatalog(batched.pool)).toEqual(
        await migrationCatalog(standard.pool),
      );
      const reapplied = await migrateTestDatabase(batched.pool, config);

      expect(reapplied.querySubmissions).toBe(5);
      expect(await migrationLedger(batched.pool, ledger)).toEqual(expected);
    }
    const adminSql =
      "SELECT id, name, email, password_hash, role, must_change_password FROM users ORDER BY id";

    expect((await batched.pool.query<AdminSeed>(adminSql)).rows).toEqual(
      (await standard.pool.query<AdminSeed>(adminSql)).rows,
    );
    const invalid = await mkdtemp(join(tmpdir(), "test-migration-rollback-"));

    try {
      await mkdir(join(invalid, "meta"));
      await writeFile(
        join(invalid, "meta/_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [
            {
              idx: 0,
              version: "7",
              when: 1,
              tag: "0000_before_failure",
              breakpoints: true,
            },
            {
              idx: 1,
              version: "7",
              when: 2,
              tag: "0001_failure",
              breakpoints: true,
            },
          ],
        }),
      );
      await writeFile(
        join(invalid, "0000_before_failure.sql"),
        "CREATE TABLE migration_rollback_probe (id integer PRIMARY KEY);\nINSERT INTO migration_rollback_probe VALUES (1)\n",
      );
      await writeFile(
        join(invalid, "0001_failure.sql"),
        "ALTER TABLE migration_rollback_probe ADD COLUMN added text;\n--> statement-breakpoint\nSELECT 1 / 0;\n",
      );
      await expect(
        migrateTestDatabase(batched.pool, {
          migrationsFolder: invalid,
          migrationsSchema: "rollback_checks",
        }),
      ).rejects.toMatchObject({ code: "22012" });
      expect(
        (
          await batched.pool.query<{ relation: string | null }>(
            "SELECT to_regclass('migration_rollback_probe') AS relation",
          )
        ).rows,
      ).toEqual([{ relation: null }]);
      expect(
        (
          await batched.pool.query<{ hash: string }>(
            "SELECT hash FROM rollback_checks.__drizzle_migrations",
          )
        ).rows,
      ).toEqual([]);
      expect(
        await migrationLedger(batched.pool, "__drizzle_migrations"),
      ).toEqual(await migrationLedger(standard.pool, "__drizzle_migrations"));
      const fullJournal = JSON.parse(
        await readFile(join(invalid, "meta/_journal.json"), "utf8"),
      ) as { entries: { idx: number; when: number; tag: string }[] };
      const incrementalConfig: MigrationConfig = {
        migrationsFolder: invalid,
        migrationsSchema: "rollback_checks",
      };

      await writeFile(
        join(invalid, "meta/_journal.json"),
        JSON.stringify({
          ...fullJournal,
          entries: fullJournal.entries.slice(0, 1),
        }),
      );
      expect(
        (await migrateTestDatabase(batched.pool, incrementalConfig))
          .querySubmissions,
      ).toBe(6);
      const firstLedger = await batched.pool.query<{
        hash: string;
        created_at: string;
      }>(
        "SELECT hash, created_at FROM rollback_checks.__drizzle_migrations ORDER BY id",
      );

      expect(firstLedger.rows).toEqual(
        readMigrationFiles(incrementalConfig).map((entry) => ({
          hash: entry.hash,
          created_at: String(entry.folderMillis),
        })),
      );
      await writeFile(
        join(invalid, "0001_failure.sql"),
        "ALTER TABLE migration_rollback_probe ADD COLUMN added text;\n--> statement-breakpoint\nUPDATE migration_rollback_probe SET added = 'literal '' quote; -- retained'; -- trailing comment",
      );
      await writeFile(
        join(invalid, "meta/_journal.json"),
        JSON.stringify(fullJournal),
      );
      expect(
        (await migrateTestDatabase(batched.pool, incrementalConfig))
          .querySubmissions,
      ).toBe(6);
      expect(
        (await migrateTestDatabase(batched.pool, incrementalConfig))
          .querySubmissions,
      ).toBe(5);
      expect(
        (
          await batched.pool.query<{ id: number; added: string }>(
            "SELECT id, added FROM migration_rollback_probe",
          )
        ).rows,
      ).toEqual([{ id: 1, added: "literal ' quote; -- retained" }]);
      expect(
        (
          await batched.pool.query<{ hash: string; created_at: string }>(
            "SELECT hash, created_at FROM rollback_checks.__drizzle_migrations ORDER BY id",
          )
        ).rows,
      ).toEqual(
        readMigrationFiles(incrementalConfig).map((entry) => ({
          hash: entry.hash,
          created_at: String(entry.folderMillis),
        })),
      );
    } finally {
      await rm(invalid, { recursive: true, force: true });
    }
  }, 180_000);

  it("stops the container when its already-closed pool rejects teardown", async () => {
    const database = await startBarePostgresTestDb({
      databaseName: "test_support_cleanup_failure",
    });

    await database.pool.end();

    try {
      await expect(database.stop()).rejects.toThrow(
        "Called end on pool more than once",
      );

      const freshPool = new Pool({ connectionString: database.databaseUrl });

      try {
        await expect(freshPool.query("SELECT 1")).rejects.toThrow();
      } finally {
        await freshPool.end();
      }
    } finally {
      await database.container.stop();
    }
  });
});
