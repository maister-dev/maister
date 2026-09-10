// S4.1 (D9 steps 2-3, 8, 10): the operator runs the Stage A/B upgrade in three
// explicit stops instead of one chain. The additive stage must commit 0131-0133
// and leave the destructive 0134/0135 untouched, the association stage must
// refuse while legacy work is still active, and a drifted migration ledger --
// which drizzle would silently skip -- must refuse before anything is applied.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigrationRootBefore } from "@/lib/db/m43-cutover-migration-root";
import {
  startBarePostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const execFileAsync = promisify(execFile);
const migrationsDir = resolve(process.cwd(), "lib/db/migrations");
const tsxPath = resolve(process.cwd(), "node_modules/.bin/tsx");
const STAGE_TAGS = [
  "0131_foamy_venom",
  "0132_soft_loa",
  "0133_rich_blob",
  "0134_lovely_tarot",
  "0135_lush_jetstream",
  "0136_shiny_the_executioner",
] as const;

let testDatabase: StartedPostgresTestDb;
let preStageRoot: string;
let runId: string;

async function migrationHash(tag: string): Promise<string> {
  const contents = await readFile(resolve(migrationsDir, `${tag}.sql`));

  return createHash("sha256").update(new Uint8Array(contents)).digest("hex");
}

async function appliedTags(): Promise<string[]> {
  const hashes = await Promise.all(
    STAGE_TAGS.map(async (tag) => ({ tag, hash: await migrationHash(tag) })),
  );
  const result = await testDatabase.pool.query<{ tag: string }>(
    `select j.tag
     from drizzle.__drizzle_migrations m
     join jsonb_to_recordset($1::jsonb) as j(tag text, hash text)
       on j.hash = m.hash
     order by j.tag`,
    [JSON.stringify(hashes)],
  );

  return result.rows.map((row) => row.tag);
}

async function runMigrationCli(
  args: readonly string[] = [],
): Promise<{ exitCode: number; output: string }> {
  try {
    const result = await execFileAsync(
      tsxPath,
      [
        "--import",
        "./scripts/_register-shim.mjs",
        "lib/db/migrate.ts",
        ...args,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DB_URL: testDatabase.databaseUrl },
      },
    );

    return { exitCode: 0, output: `${result.stdout}\n${result.stderr}` };
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

beforeAll(async () => {
  testDatabase = await startBarePostgresTestDb({
    databaseName: "staged_migrate_cli_test",
  });
  preStageRoot = await createMigrationRootBefore(
    migrationsDir,
    "0131_foamy_venom",
  );
  await migrate(testDatabase.db, { migrationsFolder: preStageRoot });

  const projectId = randomUUID();

  runId = randomUUID();
  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, 'Staged migration', '/tmp/staged-migration', '/tmp/m.yaml', $3)`,
    [
      projectId,
      `staged-${projectId.replaceAll("-", "").slice(0, 8)}`,
      `SM${projectId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
    ],
  );
  await testDatabase.pool.query(
    `insert into runs
      (id, project_id, run_kind, status, flow_version, flow_revision)
     values ($1, $2, 'flow', 'Running', 'test-flow', 'legacy')`,
    [runId, projectId],
  );
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
  if (preStageRoot) {
    await rm(preStageRoot, { recursive: true, force: true });
  }
});

describe("db:migrate --stage execution-ab", () => {
  it("refuses an unknown stage without touching the database", async () => {
    const result = await runMigrationCli(["--stage", "execution-ab"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("execution-ab-additive");
    expect(result.output).toContain("execution-ab-associations");
    expect(result.output).toContain("execution-ab-finalize");
    expect(await appliedTags()).toEqual([]);
  }, 120_000);

  it("commits the additive migrations and stops before the destructive cut-over", async () => {
    const result = await runMigrationCli(["--stage", "execution-ab-additive"]);

    expect(result.exitCode).toBe(0);
    expect(await appliedTags()).toEqual([
      "0131_foamy_venom",
      "0132_soft_loa",
      "0133_rich_blob",
    ]);

    const additiveTable = await testDatabase.pool.query(
      `select 1 from information_schema.tables
       where table_name = 'execution_data_plane_imports'`,
    );

    expect(additiveTable.rows).toHaveLength(1);

    const mirrorColumn = await testDatabase.pool.query(
      `select 1 from information_schema.columns
       where table_name = 'scratch_runs' and column_name = 'supervisor_session_id'`,
    );

    expect(mirrorColumn.rows).toHaveLength(1);
    expect(result.output).toContain("execution-ab-additive");
    expect(result.output).toContain("0133_rich_blob");
  }, 120_000);

  it("re-runs the additive stage as a satisfied no-op", async () => {
    const result = await runMigrationCli(["--stage", "execution-ab-additive"]);

    expect(result.exitCode).toBe(0);
    expect(await appliedTags()).toEqual([
      "0131_foamy_venom",
      "0132_soft_loa",
      "0133_rich_blob",
    ]);
  }, 120_000);

  it("refuses a stage whose planned migration the ledger high-water would skip", async () => {
    const hash = await migrationHash("0132_soft_loa");
    const saved = await testDatabase.pool.query<{ created_at: string }>(
      "delete from drizzle.__drizzle_migrations where hash = $1 returning created_at",
      [hash],
    );

    expect(saved.rows).toHaveLength(1);

    try {
      const result = await runMigrationCli([
        "--stage",
        "execution-ab-additive",
      ]);

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("ledger_high_water_drift");
      expect(result.output).toContain("0132_soft_loa");
    } finally {
      await testDatabase.pool.query(
        "insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)",
        [hash, saved.rows[0].created_at],
      );
    }

    expect(await appliedTags()).toEqual([
      "0131_foamy_venom",
      "0132_soft_loa",
      "0133_rich_blob",
    ]);
  }, 120_000);

  it("refuses the association stage while legacy work is still active", async () => {
    const result = await runMigrationCli([
      "--stage",
      "execution-ab-associations",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("active_legacy_work");
    expect(await appliedTags()).not.toContain("0134_lovely_tarot");
  }, 120_000);

  it("refuses the finalize stage before the association stage has run", async () => {
    const result = await runMigrationCli(["--stage", "execution-ab-finalize"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("stage_out_of_order");
    expect(await appliedTags()).not.toContain("0135_lush_jetstream");
  }, 120_000);

  it("commits the association migration alone once the drain is complete", async () => {
    await testDatabase.pool.query(
      "update runs set status = 'Done' where id = $1",
      [runId],
    );

    const result = await runMigrationCli([
      "--stage",
      "execution-ab-associations",
    ]);

    expect(result.exitCode).toBe(0);
    expect(await appliedTags()).toEqual([
      "0131_foamy_venom",
      "0132_soft_loa",
      "0133_rich_blob",
      "0134_lovely_tarot",
    ]);

    const mirrorColumn = await testDatabase.pool.query(
      `select 1 from information_schema.columns
       where table_name = 'scratch_runs' and column_name = 'supervisor_session_id'`,
    );

    expect(mirrorColumn.rows).toHaveLength(0);
  }, 120_000);

  it("commits the remaining chain once every preservation lane is proven", async () => {
    const blocked = await runMigrationCli(["--stage", "execution-ab-finalize"]);

    expect(blocked.exitCode).not.toBe(0);
    expect(await appliedTags()).not.toContain("0135_lush_jetstream");

    await testDatabase.pool.query(
      `update execution_data_plane_imports
       set state = 'complete',
           source_fingerprint = 'test-proof',
           last_source_position = 'complete',
           last_error = null,
           started_at = now(),
           completed_at = now(),
           attempts = 1
       where run_id = $1
         and source_kind in ('events', 'transcript', 'cost', 'runtime_objects')`,
      [runId],
    );

    const result = await runMigrationCli(["--stage", "execution-ab-finalize"]);

    expect(result.exitCode).toBe(0);
    expect(await appliedTags()).toEqual([...STAGE_TAGS].sort());

    const mode = await testDatabase.pool.query(
      "select execution_data_plane_mode as mode from runs where id = $1",
      [runId],
    );

    expect(mode.rows).toEqual([{ mode: "canonical_events_v1" }]);
  }, 180_000);
});
