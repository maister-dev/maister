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

it("W05 replay returns one stored signal receipt and rejects a changed body", async () => {
  const { recordWaitSignal } = await import("@/lib/waits/store");
  const signalRunId = randomUUID();
  const signalAttemptId = randomUUID();

  await database.pool.query(
    "INSERT INTO runs (id, project_id, status, flow_version, flow_revision) VALUES ($1, $2, 'Running', '1', 'legacy-revision')",
    [signalRunId, projectId],
  );
  await database.pool.query(
    "INSERT INTO node_attempts (id, run_id, node_id, node_type, status) VALUES ($1, $2, 'signal', 'wait', 'Running')",
    [signalAttemptId, signalRunId],
  );
  const waitId = randomUUID();

  await database.pool.query(
    `INSERT INTO run_waits
       (id,project_id,run_id,owner_kind,occurrence_key,node_attempt_id,flow_revision,condition_kind,condition,state,opened_at,next_due_at,deadline_at,absolute_cap_at)
     VALUES ($1,$2,$3,'flow',$4,$4,'legacy-revision','signal',
       '{"schemaVersion":1,"kind":"signal","outcomes":["passed","cancelled","timeout"],"parameters":{"name":"build"}}',
       'open',now(),now()+interval '10 minutes',now()+interval '10 minutes',now()+interval '1 day')`,
    [waitId, projectId, signalRunId, signalAttemptId],
  );

  const input = {
    projectId,
    runId: signalRunId,
    waitId,
    actor: { kind: "project_token" as const, id: "token-1" },
    idempotencyKey: "build-1",
    signal: {
      name: "build",
      outcome: "passed",
      payload: { tests: 3, passed: true },
    },
  };
  const first = await recordWaitSignal(database.db, input);

  expect(first).toMatchObject({
    disposition: "accepted",
    application: "pending",
  });
  const repeated = await recordWaitSignal(database.db, {
    ...input,
    signal: { ...input.signal, payload: { passed: true, tests: 3 } },
  });

  expect(repeated).toMatchObject({
    receiptId: first.receiptId,
    disposition: "duplicate",
    application: "pending",
  });
  await expect(
    recordWaitSignal(database.db, {
      ...input,
      signal: { ...input.signal, payload: { tests: 4 } },
    }),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "wait_key_conflict" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT id FROM run_wait_deliveries WHERE wait_id = $1",
        [waitId],
      )
    ).rows,
  ).toEqual([{ id: first.receiptId }]);
});

it("W05 a deadline extension preserves its timer instant and loses to a committed resolution", async () => {
  const { extendWaitDeadline, persistWaitResult } =
    await import("@/lib/waits/store");
  const timerRunId = randomUUID();
  const timerAttemptId = randomUUID();
  const waitId = randomUUID();

  await database.pool.query(
    "INSERT INTO runs (id, project_id, status, flow_version, flow_revision) VALUES ($1, $2, 'Running', '1', 'legacy-revision')",
    [timerRunId, projectId],
  );
  await database.pool.query(
    "INSERT INTO node_attempts (id, run_id, node_id, node_type, status) VALUES ($1, $2, 'timer', 'wait', 'Running')",
    [timerAttemptId, timerRunId],
  );
  await database.pool.query(
    `INSERT INTO run_waits
       (id,project_id,run_id,owner_kind,occurrence_key,node_attempt_id,flow_revision,condition_kind,condition,state,opened_at,timer_at,next_due_at,deadline_at,absolute_cap_at)
     VALUES ($1,$2,$3,'flow',$4,$4,'legacy-revision','timer',
       '{"schemaVersion":1,"kind":"timer","outcomes":["elapsed","cancelled","timeout"],"parameters":{"after":600}}',
       'open',now(),now()+interval '10 minutes',now()+interval '10 minutes',now()+interval '10 minutes',now()+interval '1 day')`,
    [waitId, projectId, timerRunId, timerAttemptId],
  );

  const address = { waitId, projectId, runId: timerRunId };
  const action = {
    ...address,
    userId: "operator-1",
    idempotencyKey: "extend-1",
    reason: "Widen the timeout window",
    expectedVersion: 0,
    deadline: new Date(Date.now() + 30 * 60_000),
  };
  const extended = await extendWaitDeadline(database.db, action);

  expect(extended.version).toBe(1);
  expect(await extendWaitDeadline(database.db, action)).toEqual(extended);
  expect(
    (
      await database.pool.query(
        "SELECT timer_at=next_due_at AS due_preserved FROM run_waits WHERE id=$1",
        [waitId],
      )
    ).rows,
  ).toEqual([{ due_preserved: true }]);

  const result = await database.db.transaction((tx) =>
    persistWaitResult(tx, address, 1, {
      source: "operator",
      sourceId: "operator-1",
      outcome: "cancelled",
    }),
  );

  await expect(
    database.db.transaction((tx) =>
      persistWaitResult(tx, address, 1, {
        source: "timer",
        sourceId: "deadline-1",
        outcome: "timeout",
      }),
    ),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "wait_closed" },
  });
  await expect(
    extendWaitDeadline(database.db, {
      ...action,
      idempotencyKey: "extend-2",
      expectedVersion: 2,
    }),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    details: { reason: "wait_closed" },
  });
  expect(
    (
      await database.pool.query(
        "SELECT result_digest, resume_state FROM run_waits WHERE id=$1",
        [waitId],
      )
    ).rows,
  ).toEqual([{ result_digest: result.digest, resume_state: "queued" }]);
});
