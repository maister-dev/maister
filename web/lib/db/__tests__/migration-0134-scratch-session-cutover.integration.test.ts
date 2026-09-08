// ADR-167 T4.3: a destructive scratch-session migration must preserve the
// only provable mirror and reject rows whose host ownership cannot be proven.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMainMigration,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let projectId: string;
let userId: string;
let hostId: string;
let preservedRunId: string;
let rejectedRunId: string;
let assignmentId: string;

async function insertTerminalScratchRun(input: {
  runId: string;
  sessionId: string;
}): Promise<void> {
  const { pool } = testDatabase;

  await pool.query(
    `insert into runs
      (id, project_id, run_kind, status, flow_version, flow_revision, execution_data_plane_mode)
     values ($1, $2, 'scratch', 'Crashed', 'scratch', 'manual', 'legacy_file_v1')`,
    [input.runId, projectId],
  );
  await pool.query(
    `insert into scratch_runs
      (run_id, project_id, initial_prompt, base_branch, base_commit, created_by_user_id, supervisor_session_id)
     values ($1, $2, 'resume', 'main', 'deadbeef', $3, $4)`,
    [input.runId, projectId, userId, input.sessionId],
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDbUpTo(
    { databaseName: "eh_migration_0134_test" },
    "0133_rich_blob",
  );
  projectId = randomUUID();
  userId = randomUUID();
  hostId = randomUUID();
  preservedRunId = randomUUID();
  rejectedRunId = randomUUID();
  assignmentId = randomUUID();
  const short = projectId.replace(/-/g, "").slice(0, 8);

  await testDatabase.pool.query(
    `insert into users (id, email, role, account_status)
     values ($1, $2, 'admin', 'active')`,
    [userId, `migration-0134-${short}@example.test`],
  );
  await testDatabase.pool.query(
    `insert into projects (id, slug, name, repo_path, maister_yaml_path, task_key)
     values ($1, $2, $3, $4, '/tmp/m.yaml', $5)`,
    [
      projectId,
      `m134-${short}`,
      `M134 ${short}`,
      `/tmp/m134-${short}`,
      `M${short.slice(0, 5).toUpperCase()}`,
    ],
  );
  await testDatabase.pool.query(
    `insert into execution_hosts (id, host_key, kind, display_name, transport)
     values ($1, $2, 'local_direct', 'migration host', '{"kind":"local_direct"}')`,
    [hostId, `eh_m134_${short}`],
  );

  await insertTerminalScratchRun({
    runId: preservedRunId,
    sessionId: "legacy-session-preserved",
  });
  await testDatabase.pool.query(
    `insert into execution_assignments
      (id, run_id, execution_host_id, epoch, state, placement_reason)
     values ($1, $2, $3, 1, 'active', 'launch')`,
    [assignmentId, preservedRunId, hostId],
  );

  await insertTerminalScratchRun({
    runId: rejectedRunId,
    sessionId: "legacy-session-unprovable",
  });
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("0134_lovely_tarot", () => {
  it("fails loudly before a destructive drop when an association is unprovable", async () => {
    await expect(
      applyMainMigration(testDatabase.db, "0134_lovely_tarot"),
    ).rejects.toThrow(/assignment ownership is ambiguous or missing/);

    const column = await testDatabase.pool.query(
      `select 1 from information_schema.columns
       where table_name = 'scratch_runs' and column_name = 'supervisor_session_id'`,
    );

    expect(column.rows).toHaveLength(1);
  });

  it("backfills a deterministic logical session and immutable incarnation before dropping the mirror", async () => {
    await testDatabase.pool.query(
      `delete from scratch_runs where run_id = $1`,
      [rejectedRunId],
    );
    await testDatabase.pool.query(`delete from runs where id = $1`, [
      rejectedRunId,
    ]);

    await applyMainMigration(testDatabase.db, "0134_lovely_tarot");

    const session = await testDatabase.pool.query(
      `select id, execution_assignment_id, host_session_id
       from run_sessions where run_id = $1 and session_name = 'default'`,
      [preservedRunId],
    );

    expect(session.rows).toEqual([
      {
        id: `legacy-scratch-session:${preservedRunId}`,
        execution_assignment_id: assignmentId,
        host_session_id: "legacy-session-preserved",
      },
    ]);

    const incarnation = await testDatabase.pool.query(
      `select run_id, execution_assignment_id, execution_host_id, host_session_id, origin
       from run_session_incarnations where run_id = $1`,
      [preservedRunId],
    );

    expect(incarnation.rows).toEqual([
      {
        run_id: preservedRunId,
        execution_assignment_id: assignmentId,
        execution_host_id: hostId,
        host_session_id: "legacy-session-preserved",
        origin: "legacy_backfill",
      },
    ]);

    const column = await testDatabase.pool.query(
      `select 1 from information_schema.columns
       where table_name = 'scratch_runs' and column_name = 'supervisor_session_id'`,
    );

    expect(column.rows).toHaveLength(0);
  });
});
