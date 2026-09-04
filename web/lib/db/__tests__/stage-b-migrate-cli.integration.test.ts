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

let testDatabase: StartedPostgresTestDb;
let preStageBRoot: string;
let runId: string;

async function migrationHash(tag: string): Promise<string> {
  const contents = await readFile(resolve(migrationsDir, `${tag}.sql`));

  return createHash("sha256")
    .update(new Uint8Array(contents))
    .digest("hex");
}

async function runMigrationCli(): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const result = await execFileAsync(
      tsxPath,
      ["--import", "./scripts/_register-shim.mjs", "lib/db/migrate.ts"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DB_URL: testDatabase.databaseUrl },
      },
    );

    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };

    return {
      exitCode: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}

beforeAll(async () => {
  testDatabase = await startBarePostgresTestDb({
    databaseName: "stage_b_migrate_cli_test",
  });
  preStageBRoot = await createMigrationRootBefore(
    migrationsDir,
    "0131_foamy_venom",
  );
  await migrate(testDatabase.db, { migrationsFolder: preStageBRoot });

  const projectId = randomUUID();
  runId = randomUUID();
  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, 'Stage B migration', '/tmp/stage-b-migration', '/tmp/m.yaml', $3)`,
    [
      projectId,
      `stage-b-${projectId.replaceAll("-", "").slice(0, 8)}`,
      `SB${projectId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
    ],
  );
  await testDatabase.pool.query(
    `insert into runs
      (id, project_id, run_kind, status, flow_version, flow_revision)
     values ($1, $2, 'flow', 'Done', 'test-flow', 'legacy')`,
    [runId, projectId],
  );
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
  if (preStageBRoot) {
    await rm(preStageBRoot, { recursive: true, force: true });
  }
});

describe("db:migrate Stage B cutover", () => {
  it("commits additive migrations before refusing an unpreserved legacy run", async () => {
    const first = await runMigrationCli();

    expect(first.exitCode).not.toBe(0);
    expect(`${first.stdout}\n${first.stderr}`).toContain(
      "execution-data-plane:import-legacy",
    );
    const additiveTable = await testDatabase.pool.query(
      `select 1 from information_schema.tables
       where table_name = 'execution_data_plane_imports'`,
    );
    expect(additiveTable.rows).toHaveLength(1);
    const mirrorColumn = await testDatabase.pool.query(
      `select 1 from information_schema.columns
       where table_name = 'scratch_runs'
         and column_name = 'supervisor_session_id'`,
    );
    expect(mirrorColumn.rows).toHaveLength(1);
    const applied = await testDatabase.pool.query<{ tag: string }>(
      `select j.tag
       from drizzle.__drizzle_migrations m
       join jsonb_to_recordset($1::jsonb) as j(tag text, hash text)
         on j.hash = m.hash
       where j.tag in ('0131_foamy_venom', '0132_soft_loa', '0133_rich_blob')
       order by j.tag`,
      [
        JSON.stringify(
          await Promise.all(
            [
              "0131_foamy_venom",
              "0132_soft_loa",
              "0133_rich_blob",
            ].map(async (tag) => ({ tag, hash: await migrationHash(tag) })),
          ),
        ),
      ],
    );

    expect(applied.rows).toHaveLength(3);

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

    const second = await runMigrationCli();

    expect(second.exitCode).toBe(0);
    const mode = await testDatabase.pool.query(
      "select execution_data_plane_mode as mode from runs where id = $1",
      [runId],
    );
    expect(mode.rows).toEqual([{ mode: "canonical_events_v1" }]);
    const scratchProof = await testDatabase.pool.query(
      `select state, source_fingerprint as fingerprint
       from execution_data_plane_imports
       where run_id = $1 and source_kind = 'scratch_session'`,
      [runId],
    );
    expect(scratchProof.rows).toEqual([
      { state: "complete", fingerprint: "not-a-scratch-run" },
    ]);
  });
});
