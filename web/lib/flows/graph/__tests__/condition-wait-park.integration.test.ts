import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import { mintAssignment } from "@/lib/execution-host/assignments";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "flow_condition_park",
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("W10 counts a wait only when overdue or handing off to its human node", async () => {
  const { runFlow } = await import("@/lib/flows/runner");
  const { promoteNextPending } = await import("@/lib/scheduler");
  const { runWaitDeadlineSweep } =
    await import("@/lib/scheduler/handlers/wait-deadline");
  const { listWaitDecisions } = await import("@/lib/waits/attention");
  const { seedGraphRun } = await import("@/test-support/graph-run-seed");
  const { fakeGraphHosts } = await import("@/test-support/fake-execution-host");
  const { runId, projectId, runtimeRoot, worktreePath } = await seedGraphRun(
    database.db,
    {
      schemaVersion: 1,
      name: "Deadline handoff",
      compat: { engine_min: "3.13.0" },
      nodes: [
        {
          type: "wait",
          id: "delay",
          timeout: 60,
          on: { kind: "timer", after: 120 },
          transitions: {
            elapsed: "done",
            timeout: "manual",
            cancelled: "done",
          },
        },
        {
          type: "human",
          id: "manual",
          finish: { human: { decisions: ["continue"] } },
          transitions: { continue: "done" },
        },
      ],
    },
  );

  onTestFinished(async () => {
    await Promise.all(
      [runtimeRoot, worktreePath].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });
  const { hosts } = await fakeGraphHosts(database.db, runId);
  const drive = () =>
    runFlow(runId, { db: database.db, runtimeRoot, executionHosts: hosts });
  const decisions = () =>
    listWaitDecisions(
      database.db as unknown as import("@/lib/execution-host/db").Db,
      [projectId],
    );

  await drive();
  expect(await decisions()).toEqual([]);
  await database.pool.query(
    `UPDATE run_waits SET deadline_at=opened_at+'1 microsecond'::interval,
    next_due_at=opened_at+'1 microsecond'::interval WHERE run_id=$1`,
    [runId],
  );
  expect(await decisions()).toMatchObject([{ runId, reason: "overdue" }]);
  expect(await runWaitDeadlineSweep(database.db)).toMatchObject({
    resolved: 1,
  });
  expect(await decisions()).toMatchObject([
    { runId, reason: "timeout_handoff" },
  ]);
  expect(
    (await promoteNextPending({ db: database.db, runFlow: () => undefined }))
      .promotedRunId,
  ).toBe(runId);
  await drive();

  expect(
    (
      await database.pool.query(
        "SELECT kind,step_id FROM hitl_requests WHERE run_id=$1 AND responded_at IS NULL",
        [runId],
      )
    ).rows,
  ).toEqual([{ kind: "human", step_id: "manual" }]);
  expect(await decisions()).toEqual([]);
  await database.pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
    runId,
  ]);
});

it.each(["enabled", "disabled"] as const)(
  "C04 settles an expired wait with platform control %s at decision time",
  async (setting) => {
    const { runFlow } = await import("@/lib/flows/runner");
    const { promoteNextPending } = await import("@/lib/scheduler");
    const { runWaitDeadlineSweep } =
      await import("@/lib/scheduler/handlers/wait-deadline");
    const { seedGraphRun } = await import("@/test-support/graph-run-seed");
    const { fakeGraphHosts } =
      await import("@/test-support/fake-execution-host");
    const declaration = {
      ci: "ci",
      gates: [{ node: "verify", gate: "check" }],
      review: { node: "verify", gate: "judge" },
      failure_reasons: ["wait_timeout"],
    };
    const bounds = {
      enabled: true,
      riskMax: "low",
      confidenceMin: 0.9,
      changedFilesMax: 10,
      changedLinesMax: 300,
      approvedCiSources: ["github-actions"],
    };
    const {
      runId,
      projectId,
      flowRevisionId,
      executorId,
      runtimeRoot,
      worktreePath,
    } = await seedGraphRun(
      database.db,
      {
        schemaVersion: 1,
        name: "Classified timeout",
        compat: { engine_min: "3.15.0" },
        autonomous_completion: declaration,
        nodes: [
          {
            type: "wait",
            id: "deadline",
            timeout: 60,
            on: { kind: "timer", after: 120 },
            transitions: {
              elapsed: "verify",
              timeout: { end: "failed", reason: "wait_timeout" },
              cancelled: "done",
            },
          },
          {
            type: "cli",
            id: "verify",
            action: { command: "true" },
            transitions: { success: "publish" },
            pre_finish: {
              gates: [
                {
                  id: "check",
                  kind: "command_check",
                  mode: "blocking",
                  command: "true",
                },
                {
                  id: "judge",
                  kind: "ai_judgment",
                  mode: "blocking",
                  prompt: "Review",
                },
              ],
            },
          },
          { type: "publish", id: "publish", transitions: { success: "ci" } },
          {
            type: "wait",
            id: "ci",
            timeout: 120,
            on: {
              kind: "ci",
              publication: "publish",
              transport: "pull",
              checks: ["build"],
              issuer: "github-actions",
            },
            transitions: {
              success: "done",
              failure: "done",
              cancelled: "done",
              stale: "done",
              timeout: "done",
            },
          },
        ],
      },
      {
        flowRevision: true,
        run: {
          executionPolicy: {
            preset: "unattended",
            overrides: { autonomousCompletion: "evidence_gated" },
          },
        },
      },
    );

    onTestFinished(async () => {
      await Promise.all(
        [runtimeRoot, worktreePath].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    });
    await database.pool.query(
      "UPDATE projects SET autonomous_completion=$1,autonomous_completion_revision=1 WHERE id=$2",
      [bounds, projectId],
    );
    await database.pool.query(
      "UPDATE runs SET autonomous_completion_grant=$1 WHERE id=$2",
      [
        {
          flowRevisionId,
          projectRevision: 1,
          platformRevision: 1,
          declaration,
          bounds,
        },
        runId,
      ],
    );
    await database.pool.query(
      `INSERT INTO platform_runtime_settings (id,default_runner_id,autonomous_completion_enabled,autonomous_completion_revision)
    VALUES ('singleton',$1,true,1) ON CONFLICT (id) DO UPDATE SET autonomous_completion_enabled=true, autonomous_completion_revision=1`,
      [executorId],
    );
    const { hosts } = await fakeGraphHosts(database.db, runId);
    const drive = () =>
      runFlow(runId, { db: database.db, runtimeRoot, executionHosts: hosts });

    await drive();
    if (setting === "disabled")
      await database.pool.query(
        "UPDATE platform_runtime_settings SET autonomous_completion_enabled=false,autonomous_completion_revision=2 WHERE id='singleton'",
      );
    await database.pool.query(
      `UPDATE run_waits SET deadline_at=opened_at+'10 milliseconds'::interval,
    next_due_at=opened_at+'10 milliseconds'::interval WHERE run_id=$1`,
      [runId],
    );
    expect(await runWaitDeadlineSweep(database.db)).toMatchObject({
      resolved: 1,
    });
    expect(
      (await promoteNextPending({ db: database.db, runFlow: () => undefined }))
        .promotedRunId,
    ).toBe(runId);
    await drive();

    const status = setting === "enabled" ? "Failed" : "Review";

    expect(
      (
        await database.pool.query("SELECT status FROM runs WHERE id=$1", [
          runId,
        ])
      ).rows,
    ).toEqual([{ status }]);
    const decisions = await database.pool.query(
      `SELECT d.phase,d.reason,d.platform_revision,d.created_at = r.ended_at AS same_terminal_instant
       FROM run_autonomous_decisions d JOIN runs r ON r.id=d.run_id WHERE d.run_id=$1`,
      [runId],
    );

    expect(decisions.rows).toEqual(
      setting === "enabled"
        ? [
            {
              phase: "observed",
              reason: "wait_timeout",
              platform_revision: 1,
              same_terminal_instant: true,
            },
          ]
        : [
            {
              phase: "refused",
              reason: "platform_disabled",
              platform_revision: 2,
              same_terminal_instant: true,
            },
          ],
    );
    expect(
      (
        await database.pool.query(
          "SELECT payload->'cause'->>'reason' AS reason FROM domain_events WHERE run_id=$1 AND kind='run.failed'",
          [runId],
        )
      ).rows,
    ).toEqual(setting === "enabled" ? [{ reason: "wait_timeout" }] : []);

    const { getCurrentReviewRefusals } =
      await import("@/lib/queries/autonomous-completion");
    const deskRefusal = async () =>
      (await getCurrentReviewRefusals(database.db, [runId])).get(runId);

    expect(await deskRefusal()).toBe(
      setting === "disabled" ? "platform_disabled" : undefined,
    );
    if (setting === "disabled") {
      await database.pool.query(
        "UPDATE runs SET review_entered_at = statement_timestamp() WHERE id = $1",
        [runId],
      );
      expect(await deskRefusal()).toBeUndefined();
    }
  },
);

it("W06 releases the exact assignment only when the same wait attempt parks", async () => {
  const {
    prepareConditionWait,
    commitConditionWaitPark,
    queueConditionWaitResume,
    admitConditionWaitResume,
  } = await import("@/lib/waits/lifecycle");
  const { fakeExecutionHosts } =
    await import("@/test-support/fake-execution-host");
  const { hostId } = await fakeExecutionHosts(database.db);
  const project = await seedProjectRow(database.db);
  const runId = await seedRun(database.db, {
    projectId: project.id,
    runKind: "flow",
  });
  const {
    rows: [start],
  } = await database.pool.query<{ started_at: Date }>(
    "SELECT started_at FROM runs WHERE id=$1",
    [runId],
  );
  const assignment = await database.db.transaction((tx) =>
    mintAssignment(tx, { runId, hostId, reason: "launch" }),
  );
  const nodeAttemptId = randomUUID();

  await database.pool.query(
    `UPDATE runs SET current_step_id='delay' WHERE id=$1`,
    [runId],
  );
  await database.pool.query(
    `INSERT INTO node_attempts (id,run_id,node_id,node_type,status,execution_assignment_id)
     VALUES ($1,$2,'delay','wait','Running',$3)`,
    [nodeAttemptId, runId, assignment.id],
  );
  const input = {
    projectId: project.id,
    runId,
    nodeAttemptId,
    assignmentId: assignment.id,
    condition: { kind: "timer" as const, after: 60 },
    timeoutSeconds: 120,
  };
  const intent = await database.db.transaction((tx) =>
    prepareConditionWait(tx, input),
  );
  const state = async () =>
    (
      await database.pool.query(
        `SELECT w.state AS wait_state,r.status AS run_status,a.state AS assignment_state,
                a.released_reason,w.next_due_at IS NOT NULL AS has_due_time
           FROM run_waits w JOIN runs r ON r.id=w.run_id
           JOIN execution_assignments a ON a.id=r.execution_assignment_id
          WHERE w.id=$1`,
        [intent.id],
      )
    ).rows[0];

  expect(await state()).toEqual({
    wait_state: "parking",
    run_status: "Running",
    assignment_state: "active",
    released_reason: null,
    has_due_time: false,
  });
  await expect(
    database.db.transaction((tx) =>
      commitConditionWaitPark(tx, {
        ...input,
        waitId: intent.id,
        assignmentId: randomUUID(),
        maximumSeconds: 604800,
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await state()).toMatchObject({
    wait_state: "parking",
    assignment_state: "active",
  });
  await database.db.transaction((tx) =>
    commitConditionWaitPark(tx, {
      ...input,
      waitId: intent.id,
      maximumSeconds: 604800,
    }),
  );
  expect(await state()).toEqual({
    wait_state: "open",
    run_status: "Waiting",
    assignment_state: "released",
    released_reason: "waiting_condition",
    has_due_time: true,
  });

  let releaseWinner!: () => void;
  let winnerReady!: (pid: number) => void;
  const held = new Promise<void>((release) => {
    releaseWinner = release;
  });
  const ready = new Promise<number>((resolve) => {
    winnerReady = resolve;
  });
  const winner = database.db.transaction(async (tx) => {
    const {
      rows: [backend],
    } = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);

    await queueConditionWaitResume(tx, { ...input, waitId: intent.id }, 1, {
      source: "operator",
      sourceId: "reviewer-1",
      outcome: "cancelled",
    });
    winnerReady(backend.pid);
    await held;
  });
  const pid = await Promise.race([
    ready,
    winner.then(() => {
      throw new Error("Expected winner to hold the transaction");
    }),
  ]);
  const rival = database.db
    .transaction((tx) =>
      queueConditionWaitResume(tx, { ...input, waitId: intent.id }, 1, {
        source: "timer",
        sourceId: intent.id,
        outcome: "timeout",
      }),
    )
    .catch((error: unknown) => error);

  try {
    await expect
      .poll(
        async () =>
          (
            await database.pool.query<{ blocked: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))) AS blocked",
              [pid],
            )
          ).rows[0].blocked,
      )
      .toBe(true);
  } finally {
    releaseWinner();
  }

  await winner;
  expect(await rival).toMatchObject({ code: "CONFLICT" });
  expect(await state()).toMatchObject({
    wait_state: "resolved",
    run_status: "Pending",
    assignment_state: "released",
  });

  const resumed = await database.db.transaction((tx) =>
    admitConditionWaitResume(tx, { ...input, waitId: intent.id }),
  );

  expect(resumed).toMatchObject({
    epoch: assignment.epoch + 1,
    executionHostId: hostId,
  });
  const {
    rows: [result],
  } = await database.pool.query(
    `SELECT r.started_at, r.status, n.status AS node_status, n.decision,
            w.resume_state, w.resume_assignment_id,
            (SELECT count(*)::int FROM artifact_instances a WHERE a.node_attempt_id=n.id AND a.kind='wait-result') AS results
       FROM runs r JOIN node_attempts n ON n.run_id=r.id
       JOIN run_waits w ON w.node_attempt_id=n.id WHERE w.id=$1`,
    [intent.id],
  );

  expect(result).toEqual({
    started_at: start.started_at,
    status: "Running",
    node_status: "Succeeded",
    decision: "cancelled",
    resume_state: "admitted",
    resume_assignment_id: resumed?.id,
    results: 1,
  });
  await database.pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
    runId,
  ]);
});

it("W06 drives a timer wait through the normal graph entry and common Pending admission", async () => {
  const { runFlow } = await import("@/lib/flows/runner");
  const { promoteNextPending, tryStartRun } = await import("@/lib/scheduler");
  const { runWaitDeadlineSweep } =
    await import("@/lib/scheduler/handlers/wait-deadline");
  const { seedGraphRun } = await import("@/test-support/graph-run-seed");
  const { fakeGraphHosts } = await import("@/test-support/fake-execution-host");
  const seeded = await seedGraphRun(database.db, {
    schemaVersion: 1,
    name: "Wait integration",
    compat: { engine_min: "3.13.0" },
    nodes: [
      {
        type: "wait",
        id: "delay",
        on: { kind: "timer", after: 60 },
        timeout: 120,
        transitions: { elapsed: "done", timeout: "done", cancelled: "done" },
      },
    ],
  });
  const { runId, runtimeRoot, worktreePath } = seeded;

  vi.stubEnv("MAISTER_MAX_CONCURRENT_RUNS", "1");

  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      [runtimeRoot, worktreePath].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    );
  });
  const { hosts, creates } = await fakeGraphHosts(database.db, runId);

  await runFlow(runId, { db: database.db, runtimeRoot, executionHosts: hosts });
  const {
    rows: [parked],
  } = await database.pool.query<{
    id: string;
    project_id: string;
    version: number;
    status: string;
    started_at: Date;
  }>(
    `SELECT w.id, w.project_id, w.version, r.status, r.started_at
       FROM run_waits w JOIN runs r ON r.id=w.run_id WHERE r.id=$1`,
    [runId],
  );

  expect(parked?.status).toBe("Waiting");
  expect(creates()).toEqual([]);

  const peer = await seedRun(database.db, {
    projectId: seeded.projectId,
    runKind: "flow",
    status: "Pending",
  });
  const older = await seedRun(database.db, {
    projectId: seeded.projectId,
    runKind: "flow",
    status: "Pending",
  });

  await database.pool.query(
    "UPDATE runs SET started_at=now() - interval '1 minute' WHERE id=$1",
    [peer],
  );
  await database.pool.query(
    "UPDATE runs SET started_at=now() - interval '30 seconds' WHERE id=$1",
    [older],
  );
  const drain = () =>
    promoteNextPending({ db: database.db, runFlow: () => undefined });

  expect((await drain()).promotedRunId).toBe(peer);

  await database.pool.query(
    "UPDATE run_waits SET timer_at=statement_timestamp(),next_due_at=statement_timestamp() WHERE id=$1",
    [parked.id],
  );
  expect(await runWaitDeadlineSweep(database.db)).toMatchObject({
    resolved: 1,
  });
  expect(await runWaitDeadlineSweep(database.db)).toMatchObject({
    resolved: 0,
  });
  expect((await drain()).promotedRunId).toBeNull();
  await database.pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
    peer,
  ]);
  expect(await tryStartRun(runId, { db: database.db })).toMatchObject({
    started: false,
  });
  expect((await drain()).promotedRunId).toBe(older);
  await database.pool.query("UPDATE runs SET status='Review' WHERE id=$1", [
    older,
  ]);
  const promotion = await promoteNextPending({
    db: database.db,
    runFlow: () => undefined,
  });

  expect(promotion.promotedRunId).toBe(runId);

  await runFlow(runId, { db: database.db, runtimeRoot, executionHosts: hosts });
  const result = await database.pool.query(
    `SELECT r.status, r.started_at, w.resume_state, w.result->>'outcome' AS outcome,
        (SELECT count(*)::int FROM node_attempts n WHERE n.run_id=r.id) AS attempts
       FROM runs r JOIN run_waits w ON w.run_id=r.id WHERE r.id=$1`,
    [runId],
  );

  expect(result.rows).toEqual([
    {
      status: "Review",
      outcome: "elapsed",
      started_at: parked.started_at,
      resume_state: "applied",
      attempts: 1,
    },
  ]);
});

it("W03 applies elapsed and equal-deadline timers even if another due wait fails", async () => {
  const { runFlow } = await import("@/lib/flows/runner");
  const { runWaitDeadlineSweep } =
    await import("@/lib/scheduler/handlers/wait-deadline");
  const { seedGraphRun } = await import("@/test-support/graph-run-seed");
  const { fakeGraphHosts } = await import("@/test-support/fake-execution-host");
  const parked: string[] = [];

  for (const timer of [
    { until: "2020-01-01T00:00:00Z" },
    { after: 120 },
    { after: 60 },
  ]) {
    const { runId, runtimeRoot, worktreePath } = await seedGraphRun(
      database.db,
      {
        schemaVersion: 1,
        name: "Wait clock",
        compat: { engine_min: "3.13.0" },
        nodes: [
          {
            type: "wait",
            id: "clock",
            on: { kind: "timer", ...timer },
            timeout: 120,
            transitions: {
              elapsed: "done",
              timeout: "done",
              cancelled: "done",
            },
          },
        ],
      },
    );

    onTestFinished(async () => {
      await Promise.all(
        [runtimeRoot, worktreePath].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    });
    const { hosts } = await fakeGraphHosts(database.db, runId);

    await runFlow(runId, {
      db: database.db,
      runtimeRoot,
      executionHosts: hosts,
    });
    parked.push(runId);
  }
  expect(
    (
      await database.pool.query(
        "SELECT result->>'outcome' AS outcome FROM run_waits WHERE run_id=$1",
        [parked[0]],
      )
    ).rows,
  ).toEqual([{ outcome: "elapsed" }]);
  await database.pool.query(
    `UPDATE run_waits SET timer_at=opened_at+interval '1 microsecond',
    deadline_at=opened_at+interval '1 microsecond',next_due_at=opened_at+interval '1 microsecond' WHERE run_id=$1`,
    [parked[1]],
  );
  const {
    rows: [poison],
  } = await database.pool.query<{ id: string }>(
    `UPDATE run_waits SET timer_at=opened_at-interval '1 hour',
    next_due_at=opened_at-interval '1 hour' WHERE run_id=$1 RETURNING id`,
    [parked[2]],
  );
  const resolver = await import("@/lib/waits/resolve");
  const resolveNormally = resolver.resolveObservedWait;
  const transient = vi
    .spyOn(resolver, "resolveObservedWait")
    .mockImplementation((db, address, hosts) => {
      if (address.waitId === poison.id)
        return Promise.reject(new Error("Test fixture refuses this candidate"));

      return resolveNormally(db, address, hosts);
    });

  onTestFinished(() => {
    transient.mockRestore();
  });
  expect(await runWaitDeadlineSweep(database.db)).toMatchObject({
    resolved: 1,
    errors: [poison.id],
  });
  expect(await runWaitDeadlineSweep(database.db)).toMatchObject({
    resolved: 0,
    errors: [],
  });
  const { rows } = await database.pool.query(
    "SELECT result->>'outcome' AS outcome FROM run_waits WHERE run_id=ANY($1) ORDER BY opened_at",
    [parked],
  );

  expect(rows).toEqual([
    { outcome: "elapsed" },
    { outcome: "timeout" },
    { outcome: null },
  ]);

  transient.mockRestore();
  await database.pool.query(
    `UPDATE run_waits SET opened_at=opened_at-interval '8 days',
    timer_at=timer_at-interval '8 days',deadline_at=deadline_at-interval '8 days',
    deadline_retry_at=deadline_retry_at-interval '8 days',
    next_due_at=next_due_at-interval '8 days',absolute_cap_at=absolute_cap_at-interval '8 days'
    WHERE id=$1`,
    [poison.id],
  );
  expect(await runWaitDeadlineSweep(database.db)).toMatchObject({
    resolved: 1,
    errors: [],
  });
  expect(await runWaitDeadlineSweep(database.db)).toMatchObject({ scanned: 0 });
  expect(
    (
      await database.pool.query(
        "SELECT result->>'outcome' AS outcome FROM run_waits WHERE id=$1",
        [poison.id],
      )
    ).rows,
  ).toEqual([{ outcome: "elapsed" }]);
});

it.each(["parked", "queued"] as const)(
  "W05 closes a %s wait on abandon and refuses a later signal",
  async (state) => {
    const { runFlow } = await import("@/lib/flows/runner");
    const { markAbandoned } = await import("@/lib/runs/state-transitions");
    const { recordWaitSignal } = await import("@/lib/waits/store");
    const { seedGraphRun } = await import("@/test-support/graph-run-seed");
    const { fakeGraphHosts } =
      await import("@/test-support/fake-execution-host");
    const { runId, projectId, runtimeRoot, worktreePath } = await seedGraphRun(
      database.db,
      {
        schemaVersion: 1,
        name: "Abandon a wait",
        compat: { engine_min: "3.13.0" },
        nodes: [
          {
            type: "wait",
            id: "build",
            on: { kind: "signal", name: "build", outcomes: ["success"] },
            timeout: 120,
            transitions: {
              success: "done",
              timeout: "done",
              cancelled: "done",
            },
          },
        ],
      },
    );

    onTestFinished(async () => {
      await Promise.all(
        [runtimeRoot, worktreePath].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    });
    const { hosts } = await fakeGraphHosts(database.db, runId);

    await runFlow(runId, {
      db: database.db,
      runtimeRoot,
      executionHosts: hosts,
    });
    const {
      rows: [wait],
    } = await database.pool.query<{ id: string }>(
      "SELECT id FROM run_waits WHERE run_id=$1",
      [runId],
    );
    const tokenId = randomUUID();

    await database.pool.query(
      "INSERT INTO project_tokens (id,project_id,name,prefix,token_hash,scopes) VALUES ($1,$2,'late CI',$1,$1,'[\"waits:signal\"]')",
      [tokenId, projectId],
    );
    if (state === "queued") {
      const { resolveObservedWait } = await import("@/lib/waits/resolve");

      expect(
        await recordWaitSignal(database.db, {
          projectId,
          runId,
          waitId: wait.id,
          actor: { kind: "project_token", id: tokenId },
          idempotencyKey: "before-abandon",
          signal: { name: "build", outcome: "success" },
        }),
      ).toMatchObject({ disposition: "accepted" });
      expect(
        await resolveObservedWait(
          database.db,
          { projectId, runId, waitId: wait.id },
          hosts,
        ),
      ).toBe(true);
    }
    expect(
      await markAbandoned(runId, {
        db: database.db as unknown as import("@/lib/execution-host/db").Db,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await recordWaitSignal(database.db, {
        projectId,
        runId,
        waitId: wait.id,
        actor: { kind: "project_token", id: tokenId },
        idempotencyKey: "after-abandon",
        signal: { name: "build", outcome: "success" },
      }),
    ).toMatchObject({
      disposition: "rejected",
      application: "not_applied",
      reason: "wait_closed",
    });
    expect(
      (
        await database.pool.query(
          `SELECT r.status,w.state,w.resume_state,w.result FROM runs r JOIN run_waits w ON r.id=w.run_id WHERE r.id=$1`,
          [runId],
        )
      ).rows,
    ).toEqual([
      state === "queued"
        ? {
            status: "Abandoned",
            state: "resolved",
            resume_state: "invalidated",
            result: expect.objectContaining({ outcome: "success" }),
          }
        : {
            status: "Abandoned",
            state: "closed",
            resume_state: null,
            result: null,
          },
    ]);
    const { promoteNextPending } = await import("@/lib/scheduler");

    expect(
      (await promoteNextPending({ db: database.db, runFlow: () => undefined }))
        .promotedRunId,
    ).not.toBe(runId);
  },
);

it.each(["head movement", "host outage"] as const)(
  "W07 separates a wrong-SHA delivery from %s on the released assignment",
  async (source) => {
    const { runFlow } = await import("@/lib/flows/runner");
    const { resolveObservedWait } = await import("@/lib/waits/resolve");
    const { recordWaitSignal } = await import("@/lib/waits/store");
    const { seedGraphRun } = await import("@/test-support/graph-run-seed");
    const { fakeGraphHosts } =
      await import("@/test-support/fake-execution-host");
    const { runId, projectId, runtimeRoot, worktreePath } = await seedGraphRun(
      database.db,
      {
        schemaVersion: 1,
        name: "Bound signal",
        compat: { engine_min: "3.13.0" },
        nodes: [
          {
            type: "wait",
            id: "ci",
            timeout: 120,
            on: {
              kind: "signal",
              name: "ci",
              outcomes: ["success"],
              bind: "head_sha",
            },
            transitions: {
              success: "done",
              stale: "done",
              timeout: "done",
              cancelled: "done",
            },
          },
        ],
      },
    );

    onTestFinished(async () => {
      await Promise.all(
        [runtimeRoot, worktreePath].map((path) =>
          rm(path, { recursive: true, force: true }),
        ),
      );
    });

    const { hosts, fake } = await fakeGraphHosts(database.db, runId);
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    let observed = a;
    let unavailable = false;
    const reads: Array<{ register?: true }> = [];

    fake.transport.observeWaitWorkspaceHead = async (_id, envelope) => {
      reads.push(envelope.payload);
      if (unavailable)
        throw new MaisterError(
          "EXECUTOR_UNAVAILABLE",
          "Host offline in fixture",
        );

      return { headSha: observed };
    };
    await runFlow(runId, {
      db: database.db,
      runtimeRoot,
      executionHosts: hosts,
    });

    const {
      rows: [wait],
    } = await database.pool.query<{ id: string; binding_head_sha: string }>(
      "SELECT id,binding_head_sha FROM run_waits WHERE run_id=$1",
      [runId],
    );
    const address = { runId, projectId, waitId: wait.id };

    expect(wait.binding_head_sha).toBe(a);
    expect(
      await recordWaitSignal(database.db, {
        ...address,
        actor: { kind: "project_token", id: "fixture" },
        idempotencyKey: "old-receipt",
        signal: { name: "ci", outcome: "success", headSha: b },
      }),
    ).toMatchObject({ disposition: "stale", application: "not_applied" });
    expect(await resolveObservedWait(database.db, address, hosts)).toBe(false);
    if (source === "host outage") {
      const tokenId = randomUUID();

      await database.pool.query(
        `INSERT INTO project_tokens (id,project_id,name,prefix,token_hash,scopes)
       VALUES ($1,$2,'CI for offline host',$1,$1,'["waits:signal"]')`,
        [tokenId, projectId],
      );
      expect(
        await recordWaitSignal(database.db, {
          ...address,
          actor: { kind: "project_token", id: tokenId },
          idempotencyKey: "correct-but-unconfirmed",
          signal: { name: "ci", outcome: "success", headSha: a },
        }),
      ).toMatchObject({ disposition: "accepted", application: "pending" });
      unavailable = true;
      expect(await resolveObservedWait(database.db, address, hosts)).toBe(
        false,
      );
      await database.pool.query(
        `UPDATE run_waits SET deadline_at=opened_at,next_due_at=opened_at WHERE id=$1`,
        [wait.id],
      );
      expect(await resolveObservedWait(database.db, address, hosts)).toBe(true);
      expect(await resolveObservedWait(database.db, address, hosts)).toBe(
        false,
      );
      expect(
        (
          await database.pool.query(
            `SELECT result->>'outcome' AS outcome, result->>'source' AS source FROM run_waits WHERE id=$1`,
            [wait.id],
          )
        ).rows,
      ).toEqual([{ outcome: "timeout", source: "timer" }]);

      return;
    }
    observed = b;
    expect(await resolveObservedWait(database.db, address, hosts)).toBe(true);
    expect(await resolveObservedWait(database.db, address, hosts)).toBe(false);
    const state = await database.pool.query(
      "SELECT result FROM run_waits WHERE id=$1",
      [wait.id],
    );

    expect(state.rows[0].result).toMatchObject({
      outcome: "stale",
      source: "head",
      data: { boundHeadSha: a, observedHeadSha: b },
    });
    expect(reads).toMatchObject([{ register: true }, {}, {}]);
  },
);
