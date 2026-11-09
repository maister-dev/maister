import type { PoolClient } from "pg";
import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createMigrationRootThrough } from "@/lib/db/m43-cutover-migration-root";
import { migrateTestDatabase } from "@/test-support/migrate-test-database";
import {
  startBarePostgresTestDb,
  startMainPostgresTestDb,
} from "@/test-support/pg-container";

const execFileAsync = promisify(execFile);
const applicationName = "migration-timeout-qualification";

type MigrationCliResult = Readonly<{
  exitCode: number;
  output: string;
}>;
type MigrationLedger = "__drizzle_migrations" | "__drizzle_brain_migrations";
type AppliedMigration = Readonly<{ hash: string; created_at: string }>;

async function runMigrationCli(
  database: StartedPostgresTestDb,
  script: "migrate.ts" | "migrate-brain.ts",
): Promise<MigrationCliResult> {
  const url = new URL(database.databaseUrl);

  url.searchParams.set("application_name", applicationName);
  url.searchParams.set("options", "-c lock_timeout=0 -c statement_timeout=0");
  try {
    const result = await execFileAsync(
      resolve("node_modules/.bin/tsx"),
      ["--import", "./scripts/_register-shim.mjs", `lib/db/${script}`],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DB_URL: url.toString(),
          MAISTER_UPGRADE_MAINTENANCE: "1",
        },
        timeout: 45_000,
      },
    );

    return {
      exitCode: 0,
      output: `${result.stdout}\n${result.stderr}`,
    };
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };

    return {
      exitCode: failure.code ?? 1,
      output: `${failure.stdout ?? ""}\n${failure.stderr ?? failure.message}`,
    };
  }
}

async function appliedMigrations(
  database: StartedPostgresTestDb,
  ledger: MigrationLedger,
): Promise<AppliedMigration[]> {
  const result = await database.pool.query<AppliedMigration>(
    `SELECT hash,created_at::text FROM drizzle.${ledger} ORDER BY created_at,id`,
  );

  return result.rows;
}

async function runBlockedMigration(
  database: StartedPostgresTestDb,
  blocker: PoolClient,
  run: () => Promise<MigrationCliResult>,
): Promise<MigrationCliResult> {
  let settled: MigrationCliResult | undefined;
  const running = run().then((result) => {
    settled = result;

    return result;
  });
  let scheduledRelease: Promise<unknown> = Promise.resolve();
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    await expect
      .poll(
        async () => {
          if (settled) return true;
          const waiting = await database.pool.query<{ waiting: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock') AS waiting",
            [applicationName],
          );

          return waiting.rows[0].waiting;
        },
        { timeout: 15_000, interval: 25 },
      )
      .toBe(true);
    if (!settled)
      releaseTimer = setTimeout(() => {
        scheduledRelease = blocker.query("ROLLBACK");
      }, 8_000);

    return await running;
  } finally {
    clearTimeout(releaseTimer);
    await scheduledRelease;
    await blocker.query("ROLLBACK");
    await running;
  }
}

async function requireSessionBoundsBeforeDdl(
  database: StartedPostgresTestDb,
): Promise<void> {
  await database.pool.query(
    `
    CREATE FUNCTION qualify_migration_session() RETURNS event_trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('application_name')='${applicationName}' AND
        (current_setting('lock_timeout')<>'5s' OR current_setting('statement_timeout')<>'2min') THEN
        RAISE EXCEPTION 'Migration session must establish lock and statement bounds before metadata or DDL';
      END IF;
    END $$;
    CREATE EVENT TRIGGER qualify_migration_session
      ON ddl_command_start EXECUTE FUNCTION qualify_migration_session();
  `,
  );
}

it("bounds the actual main upgrade after0230, preserves its ledger on lock refusal, and retries with both session limits", async () => {
  const database = await startBarePostgresTestDb({
    databaseName: "main_migration_session",
  });
  const root = await createMigrationRootThrough(
    resolve("lib/db/migrations"),
    "0232_company_grant_requests",
  );
  let blocker: PoolClient | undefined;

  try {
    await migrateTestDatabase(database.pool, { migrationsFolder: root });
    const userId = randomUUID();

    await database.pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [userId, `${userId}@example.test`],
    );
    const before = await appliedMigrations(database, "__drizzle_migrations");

    blocker = await database.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE company_grants IN ACCESS EXCLUSIVE MODE");
    const refused = await runBlockedMigration(database, blocker, () =>
      runMigrationCli(database, "migrate.ts"),
    );

    expect(refused.exitCode, refused.output).not.toBe(0);
    expect(refused.output).toContain("lock timeout");
    expect(await appliedMigrations(database, "__drizzle_migrations")).toEqual(
      before,
    );
    expect(
      (
        await database.pool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_name='node_attempts' AND column_name='knowledge_actor'",
        )
      ).rows,
    ).toEqual([]);
    await requireSessionBoundsBeforeDdl(database);
    const recovered = await runMigrationCli(database, "migrate.ts");

    expect(recovered.exitCode, recovered.output).toBe(0);
    expect(
      (await appliedMigrations(database, "__drizzle_migrations")).length,
    ).toBeGreaterThan(before.length);
    expect(
      (
        await database.pool.query<{ email: string }>(
          "SELECT email FROM users WHERE id=$1",
          [userId],
        )
      ).rows,
    ).toEqual([{ email: `${userId}@example.test` }]);
    const committed = await appliedMigrations(database, "__drizzle_migrations");

    expect((await runMigrationCli(database, "migrate.ts")).exitCode).toBe(0);
    expect(await appliedMigrations(database, "__drizzle_migrations")).toEqual(
      committed,
    );
  } finally {
    blocker?.release();
    await rm(root, { recursive: true, force: true });
    await database.stop();
  }
}, 90_000);

it("bounds Brain ledger access before pending SQL, preserves legacy content on refusal, and retries with both session limits", async () => {
  const database = await startMainPostgresTestDb({
    databaseName: "brain_migration_session",
  });
  const root = await createMigrationRootThrough(
    resolve("lib/db/brain-migrations"),
    "0006_brain_indexing_profiles",
  );
  let blocker: PoolClient | undefined;

  try {
    await migrateTestDatabase(database.pool, {
      migrationsFolder: root,
      migrationsTable: "__drizzle_brain_migrations",
    });
    const projectId = randomUUID();
    const itemId = randomUUID();

    await database.pool.query(
      "INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES($1,$1,'Migration witness',$2,'MIGRATE')",
      [projectId, `/tmp/migration-${projectId}`],
    );
    await database.pool.query(
      "INSERT INTO brain_items(id,project_id,kind,title,content,confidence,content_hash) VALUES($1,$2,'observation','Retained input','Original legacy evidence',0.7,$3)",
      [itemId, projectId, "a".repeat(64)],
    );
    const before = await appliedMigrations(
      database,
      "__drizzle_brain_migrations",
    );

    blocker = await database.pool.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      "LOCK TABLE drizzle.__drizzle_brain_migrations IN ACCESS EXCLUSIVE MODE",
    );
    const refused = await runBlockedMigration(database, blocker, () =>
      runMigrationCli(database, "migrate-brain.ts"),
    );

    expect(refused.exitCode, refused.output).not.toBe(0);
    expect(refused.output).toContain("lock timeout");
    expect(
      await appliedMigrations(database, "__drizzle_brain_migrations"),
    ).toEqual(before);
    expect(
      (
        await database.pool.query<{ content: string }>(
          "SELECT content FROM brain_items WHERE id=$1",
          [itemId],
        )
      ).rows,
    ).toEqual([{ content: "Original legacy evidence" }]);
    await requireSessionBoundsBeforeDdl(database);
    const recovered = await runMigrationCli(database, "migrate-brain.ts");

    expect(recovered.exitCode, recovered.output).toBe(0);
    expect(
      (await appliedMigrations(database, "__drizzle_brain_migrations")).length,
    ).toBeGreaterThan(before.length);
    expect(
      (
        await database.pool.query<{ content: string }>(
          "SELECT content FROM brain_items WHERE id=$1",
          [itemId],
        )
      ).rows,
    ).toEqual([{ content: "Original legacy evidence" }]);
  } finally {
    blocker?.release();
    await rm(root, { recursive: true, force: true });
    await database.stop();
  }
}, 90_000);
