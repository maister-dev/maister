import { randomUUID } from "node:crypto";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const predecessor = "0357_agent_continuation_episodes";
const runId = randomUUID();
const attemptId = randomUUID();

let database: StartedPostgresTestDb;
let projectId: string;
let foreignProjectId: string;
let foreignAttemptId: string;
let ownerRunId: string;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "flow_waits_upgrade" },
    predecessor,
  );
  await declareCurrentTestDatabaseWriter(database);
  const project = await seedProjectRow(database.db);
  const foreign = await seedProjectRow(database.db);

  projectId = project.id;
  foreignProjectId = foreign.id;
  foreignAttemptId = randomUUID();
  const foreignRunId = randomUUID();

  ownerRunId = randomUUID();
  await database.pool.query(
    `INSERT INTO runs (id, project_id, status, flow_version, flow_revision, execution_policy)
     VALUES ($1, $2, 'WaitingOnChildren', '1', 'legacy-revision', '{"preset":"supervised"}'),
            ($3, $4, 'Running', '1', 'foreign-revision', '{"preset":"supervised"}')`,
    [runId, projectId, foreignRunId, foreignProjectId],
  );
  await upgradeMainTestDb(database, predecessor);
  await database.pool.query(
    "INSERT INTO runs (id, project_id, status, flow_version, flow_revision) VALUES ($1, $2, 'Running', '1', 'legacy-revision')",
    [ownerRunId, projectId],
  );
  await database.pool.query(
    `INSERT INTO node_attempts (id, run_id, node_id, node_type, status)
     VALUES ($1, $2, 'wait', 'wait', 'Running'),
            ($3, $4, 'wait', 'wait', 'Running')`,
    [attemptId, ownerRunId, foreignAttemptId, foreignRunId],
  );
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("W01 preserves predecessor evidence and fences the exact project/run/attempt tuple in SQL", async () => {
  const legacy = () =>
    database.pool.query<{
      status: string;
      flow_revision: string;
      execution_policy: { preset: string };
    }>("SELECT status, flow_revision, execution_policy FROM runs WHERE id=$1", [
      runId,
    ]);
  const expected = [
    {
      status: "WaitingOnChildren",
      flow_revision: "legacy-revision",
      execution_policy: { preset: "supervised" },
    },
  ];

  expect((await legacy()).rows).toEqual(expected);
  expect((await database.pool.query("SELECT id FROM run_waits")).rows).toEqual(
    [],
  );

  const insertWait = (
    waitId: string,
    ownerProjectId: string,
    ownerAttemptId: string,
    state: "open" | "resolved" = "open",
  ) =>
    database.pool.query(
      `INSERT INTO run_waits
       (id, project_id, run_id, owner_kind, occurrence_key, node_attempt_id,
        flow_revision, condition_kind, condition, state, opened_at,
        timer_at, next_due_at, deadline_at, absolute_cap_at)
       VALUES ($1, $2, $3, 'flow', $4, $5, 'legacy-revision', 'timer',
               '{"schemaVersion":1,"kind":"timer","after":10}', $6,
               '2026-11-20T12:00:00Z', '2026-11-20T12:00:10Z', '2026-11-20T12:00:10Z',
               '2026-11-20T12:01:00Z', '2026-11-27T12:00:00Z')`,
      [waitId, ownerProjectId, ownerRunId, waitId, ownerAttemptId, state],
    );

  await expect(
    insertWait("foreign-project", foreignProjectId, attemptId),
  ).rejects.toMatchObject({
    code: "23503",
    constraint: "run_waits_owner_run_fk",
  });
  await expect(
    insertWait("foreign-attempt", projectId, foreignAttemptId),
  ).rejects.toMatchObject({
    code: "23503",
    constraint: "run_waits_owner_attempt_fk",
  });
  await expect(
    insertWait("unproved-result", projectId, attemptId, "resolved"),
  ).rejects.toMatchObject({
    code: "23514",
    constraint: "run_waits_result_check",
  });

  await insertWait("retained-wait", projectId, attemptId);
  await expect(
    insertWait("duplicate-attempt", projectId, attemptId),
  ).rejects.toMatchObject({
    code: "23505",
    constraint: "run_waits_attempt_unique",
  });

  await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
  expect((await legacy()).rows).toEqual(expected);
  expect((await database.pool.query("SELECT id FROM run_waits")).rows).toEqual([
    { id: "retained-wait" },
  ]);

  const { rows: indexes } = await database.pool.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE indexname='run_waits_due_idx'",
  );

  expect(indexes[0]?.indexdef).toMatch(
    /greatest\(next_due_at, deadline_retry_at\), id\).*state.*open/i,
  );

  await database.pool.query("DELETE FROM runs WHERE id=$1", [ownerRunId]);
  expect((await database.pool.query("SELECT id FROM run_waits")).rows).toEqual(
    [],
  );
});
