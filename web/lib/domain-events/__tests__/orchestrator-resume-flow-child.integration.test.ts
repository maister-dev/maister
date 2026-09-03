import type { DomainEventRow } from "@/lib/db/schema";
import type { RunFlowOptions } from "@/lib/flows/graph/runner-core";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { runFlow } from "@/lib/flows/runner";
import { schema, seedGraphRun } from "@/test-support/graph-run-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-163 REQ-18: before this change a flow run reaching `Review` emitted ONLY
// the webhook event, while its Failed/Crashed siblings emitted a DOMAIN event
// carrying parent_run_id. A delegated flow child would therefore run to a
// perfectly good diff and its parent would sit in WaitingOnChildren forever —
// the "a status nothing emits on is a deadlock" class.
//
// This file proves both halves of the wake chain: that the graph runner EMITS
// (driving the real runner to Review, not hand-writing the row), and that the
// consumer WAKES on it with the sibling gate intact.

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let buildOrchestratorResumeConsumer: typeof import("@/lib/domain-events/orchestrator-resume").buildOrchestratorResumeConsumer;
let emitDomainEvent: typeof import("@/lib/domain-events/outbox").emitDomainEvent;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "orch_resume_flow_child_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  // ADR-166: every launch places the run on the local execution host.
  await fakeExecutionHosts(db);

  ({ buildOrchestratorResumeConsumer } = await import(
    "@/lib/domain-events/orchestrator-resume"
  ));
  ({ emitDomainEvent } = await import("@/lib/domain-events/outbox"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

const CLI_MANIFEST = {
  schemaVersion: 1,
  name: "delegated",
  compat: { engine_min: "3.0.0" },
  nodes: [
    {
      id: "work",
      type: "cli",
      action: { command: "echo done" },
      transitions: { success: "done" },
    },
  ],
};

async function domainEventsFor(
  runId: string,
  kind: string,
): Promise<DomainEventRow[]> {
  return (await db
    .select()
    .from(schema.domainEvents)
    .where(
      and(
        eq(schema.domainEvents.runId, runId),
        eq(schema.domainEvents.kind, kind),
      ),
    )) as DomainEventRow[];
}

async function webhookEventsFor(runId: string): Promise<{ type: string }[]> {
  const rows = await pool.query(
    `SELECT "type" FROM "webhook_events" WHERE "run_id" = $1`,
    [runId],
  );

  return rows.rows;
}

/**
 * Seed an orchestrator parent for a graph run that already exists, and point
 * the child at it. Done as an UPDATE rather than a seed option because
 * `runs.parent_run_id` is a self-FK — the parent row has to exist first, and
 * the child's own project is only known after seeding it.
 */
async function attachParent(args: {
  childRunId: string;
  projectId: string;
  flowId: string;
  status?: string;
  currentStepId?: string | null;
}): Promise<string> {
  const parentRunId = randomUUID();
  const parentTaskId = randomUUID();

  await (db as any).insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: parentTaskId,
    projectId: args.projectId,
    title: "orchestrator",
    prompt: "coordinate",
    flowId: args.flowId,
  });
  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
       "status", "current_step_id", "flow_version", "flow_revision")
     VALUES ($1, 'flow', $2, $3, $4, $5, $6, 'v1.0.0', 'unknown')`,
    [
      parentRunId,
      args.projectId,
      parentTaskId,
      args.flowId,
      args.status ?? "WaitingOnChildren",
      args.currentStepId === undefined ? "coordinate" : args.currentStepId,
    ],
  );
  await (db as any).insert(schema.nodeAttempts).values({
    id: randomUUID(),
    runId: parentRunId,
    nodeId: "coordinate",
    nodeType: "orchestrator",
    attempt: 1,
    status: "NeedsInput",
  });
  await pool.query(
    `UPDATE "runs" SET "parent_run_id" = $2, "root_run_id" = $2, "launch_mode" = 'manual' WHERE "id" = $1`,
    [args.childRunId, parentRunId],
  );

  return parentRunId;
}

describe("a delegated flow child reaching Review (ADR-163 REQ-18)", () => {
  it("emits the run.review DOMAIN event carrying parentRunId, alongside the webhook", async () => {
    const seeded = await seedGraphRun(db, CLI_MANIFEST, {
      flowRefId: "delegated",
      flowRevision: true,
    });
    const parentRunId = await attachParent({
      childRunId: seeded.runId,
      projectId: seeded.projectId,
      flowId: seeded.flowId,
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const status = (
      await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [
        seeded.runId,
      ])
    ).rows[0].status;

    expect(status).toBe("Review");

    const domainEvents = await domainEventsFor(seeded.runId, "run.review");

    expect(domainEvents).toHaveLength(1);
    const payload = domainEvents[0].payload as Record<string, unknown>;

    expect(payload.parentRunId).toBe(parentRunId);
    expect(payload.runKind).toBe("flow");
    expect(payload.status).toBe("Review");
    expect(domainEvents[0].taskId).toBe(seeded.taskId);

    // The pre-existing webhook emit is untouched — the domain event is an
    // addition, not a replacement.
    expect(await webhookEventsFor(seeded.runId)).toContainEqual({
      type: "run.review",
    });
  }, 60_000);

  it("a TOP-LEVEL flow run reaching Review emits the webhook but NO domain event", async () => {
    const seeded = await seedGraphRun(db, CLI_MANIFEST, {
      flowRefId: "toplevel",
      flowRevision: true,
    });

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect(await domainEventsFor(seeded.runId, "run.review")).toHaveLength(0);
    expect(await webhookEventsFor(seeded.runId)).toContainEqual({
      type: "run.review",
    });
  }, 60_000);
});

describe("orchestrator_resume wakes on a FLOW child (ADR-163 REQ-18/REQ-20)", () => {
  let projectId: string;
  let flowId: string;
  let executorId: string;

  beforeEach(async () => {
    const seeded = await seedGraphRun(db, CLI_MANIFEST, {
      flowRefId: "consumer",
      workspace: false,
    });

    projectId = seeded.projectId;
    flowId = seeded.flowId;
    executorId = seeded.executorId;

    // The seeded run is scaffolding for the project/flow rows; the consumer
    // cases seed their own parent + children explicitly.
    await pool.query(`DELETE FROM "run_sessions" WHERE "run_id" = $1`, [
      seeded.runId,
    ]);
    await pool.query(`DELETE FROM "runs" WHERE "id" = $1`, [seeded.runId]);
  });

  async function seedParkedOrchestrator(): Promise<string> {
    const taskId = randomUUID();
    const runId = randomUUID();

    await (db as any).insert(schema.tasks).values({
      number: Math.trunc(Math.random() * 1e9) + 1,
      id: taskId,
      projectId,
      title: "orc",
      prompt: "coordinate",
      flowId,
    });
    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
         "status", "current_step_id", "flow_version", "flow_revision")
       VALUES ($1, 'flow', $2, $3, $4, 'WaitingOnChildren', 'coordinate', 'v1.0.0', 'unknown')`,
      [runId, projectId, taskId, flowId],
    );
    await pool.query(
      `INSERT INTO "run_sessions" ("id", "run_id", "session_name", "runner_id", "acp_session_id")
       VALUES ($1, $2, 'default', $3, 'acp-coord-1')`,
      [randomUUID(), runId, executorId],
    );
    await (db as any).insert(schema.nodeAttempts).values({
      id: randomUUID(),
      runId,
      nodeId: "coordinate",
      nodeType: "orchestrator",
      attempt: 1,
      status: "NeedsInput",
    });

    return runId;
  }

  /** A FLOW child in `status`, plus (optionally) its settled domain event. */
  async function seedFlowChild(args: {
    parentRunId: string;
    status: string;
    emit?: "run.review" | "run.failed" | "run.done" | null;
    /** ADR-165: extra payload fields (`resultStatus`, `completion`). */
    payload?: Record<string, unknown>;
  }): Promise<{ runId: string; event: DomainEventRow | null }> {
    const childTaskId = randomUUID();
    const childRunId = randomUUID();

    await (db as any).insert(schema.tasks).values({
      number: Math.trunc(Math.random() * 1e9) + 1,
      id: childTaskId,
      projectId,
      title: "child",
      prompt: "p",
      flowId,
    });
    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
         "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id", "launch_mode")
       VALUES ($1, 'flow', $2, $3, $4, $5, 'v1.0.0', 'unknown', $6, $6, 'manual')`,
      [
        childRunId,
        projectId,
        childTaskId,
        flowId,
        args.status,
        args.parentRunId,
      ],
    );
    await pool.query(
      `INSERT INTO "run_sessions" ("id", "run_id", "session_name", "runner_id")
       VALUES ($1, $2, 'default', $3)`,
      [randomUUID(), childRunId, executorId],
    );

    if (!args.emit) return { runId: childRunId, event: null };

    await emitDomainEvent({
      db,
      kind: args.emit,
      projectId,
      taskId: childTaskId,
      runId: childRunId,
      actor: { type: "system", id: null },
      parentRunId: args.parentRunId,
      payload: {
        runKind: "flow",
        status: args.status,
        ...(args.payload ?? {}),
      },
    });

    const rows = await domainEventsFor(childRunId, args.emit);

    return { runId: childRunId, event: rows[0] };
  }

  async function statusOf(runId: string): Promise<string> {
    const rows = await pool.query(
      `SELECT "status" FROM "runs" WHERE "id" = $1`,
      [runId],
    );

    return rows.rows[0].status;
  }

  it("(1) one flow child reaching Review CASes the parent WaitingOnChildren → Running and resumes at the coordinator node", async () => {
    const parentRunId = await seedParkedOrchestrator();
    const { event } = await seedFlowChild({
      parentRunId,
      status: "Review",
      emit: "run.review",
    });

    const resumed: Array<{ runId: string; opts: RunFlowOptions }> = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId, opts) => {
        resumed.push({ runId, opts });
      },
    });

    await consumer.handle([event!]);

    expect(await statusOf(parentRunId)).toBe("Running");
    expect(resumed).toHaveLength(1);
    expect(resumed[0].runId).toBe(parentRunId);
    expect(resumed[0].opts.orchestratorResume).toEqual({
      targetStepId: "coordinate",
    });
  });

  it("(2) a flow child reaching Review while a sibling is still Running does NOT wake the parent", async () => {
    const parentRunId = await seedParkedOrchestrator();

    await seedFlowChild({ parentRunId, status: "Running" });

    const { event } = await seedFlowChild({
      parentRunId,
      status: "Review",
      emit: "run.review",
    });

    const resumed: string[] = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId) => {
        resumed.push(runId);
      },
    });

    await consumer.handle([event!]);

    expect(await statusOf(parentRunId)).toBe("WaitingOnChildren");
    expect(resumed).toHaveLength(0);
  });

  it("(3) a flow child reaching a FAILURE terminal wakes the parent even with a pending sibling", async () => {
    const parentRunId = await seedParkedOrchestrator();

    await seedFlowChild({ parentRunId, status: "Running" });

    const { event } = await seedFlowChild({
      parentRunId,
      status: "Failed",
      emit: "run.failed",
    });

    const resumed: string[] = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId) => {
        resumed.push(runId);
      },
    });

    await consumer.handle([event!]);

    expect(await statusOf(parentRunId)).toBe("Running");
    expect(resumed).toEqual([parentRunId]);
  });
  // ADR-163 review F1: the runner's Review branch is not the only way a
  // delegated child enters Review — the ADR-160 rework-claim release and both
  // ADR-141 sync-resolver returns flip to Review too. Each takes the child
  // through a NON-settled status and back, so a sibling settle inside that
  // window leaves the parent waiting on a status nothing announces. Every
  // Review flip of a child must emit, top-level flips must not.
  describe("every Review flip of a delegated child emits run.review (ADR-163 review F1)", () => {
    let transitions: typeof import("@/lib/runs/state-transitions");

    beforeAll(async () => {
      transitions = await import("@/lib/runs/state-transitions");
    });

    async function seedTopLevelFlowRun(status: string): Promise<string> {
      const taskId = randomUUID();
      const runId = randomUUID();

      await (db as any).insert(schema.tasks).values({
        number: Math.trunc(Math.random() * 1e9) + 1,
        id: taskId,
        projectId,
        title: "top",
        prompt: "p",
        flowId,
      });
      await pool.query(
        `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
           "status", "flow_version", "flow_revision")
         VALUES ($1, 'flow', $2, $3, $4, $5, 'v1.0.0', 'unknown')`,
        [runId, projectId, taskId, flowId, status],
      );

      return runId;
    }

    const flips: Array<{
      name: string;
      from: string;
      flip: (runId: string) => Promise<{ ok: boolean }>;
    }> = [
      {
        name: "markSyncReviewFromRunning",
        from: "Running",
        flip: (runId) => transitions.markSyncReviewFromRunning(runId, { db }),
      },
      {
        name: "markSyncReviewFromNeedsInput",
        from: "NeedsInput",
        flip: (runId) =>
          transitions.markSyncReviewFromNeedsInput(runId, "NeedsInput", { db }),
      },
      {
        name: "markReviewFromReworkClaim",
        from: "HumanWorking",
        flip: (runId) => transitions.markReviewFromReworkClaim(runId, { db }),
      },
    ];

    it.each(flips)(
      "$name on a delegated child emits run.review carrying parentRunId",
      async ({ from, flip }) => {
        const parentRunId = await seedParkedOrchestrator();
        const { runId } = await seedFlowChild({ parentRunId, status: from });

        expect(await flip(runId)).toEqual({ ok: true });
        expect(await statusOf(runId)).toBe("Review");

        const events = await domainEventsFor(runId, "run.review");

        expect(events).toHaveLength(1);
        expect(events[0].payload).toMatchObject({
          parentRunId,
          runKind: "flow",
          status: "Review",
        });
      },
    );

    it.each(flips)(
      "$name on a TOP-LEVEL run emits no run.review domain event",
      async ({ from, flip }) => {
        const runId = await seedTopLevelFlowRun(from);

        expect(await flip(runId)).toEqual({ ok: true });
        expect(await statusOf(runId)).toBe("Review");
        expect(await domainEventsFor(runId, "run.review")).toHaveLength(0);
      },
    );
  });

  // ADR-165 AC-18: the payload widening is ADDITIVE. `orchestrator_resume`
  // reads `kind` + `parentRunId` + the pending-sibling count and nothing else,
  // so a result-only `run.done` and a result-caused `run.failed` must route
  // exactly like their plain siblings.
  it("(ADR-165) a result-only run.done wakes the parent like any success-side settle", async () => {
    const parentRunId = await seedParkedOrchestrator();
    const { event } = await seedFlowChild({
      parentRunId,
      status: "Done",
      emit: "run.done",
      payload: { completion: "result_only", resultStatus: "valid" },
    });

    const resumed: string[] = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId) => {
        resumed.push(runId);
      },
    });

    await consumer.handle([event!]);

    expect(await statusOf(parentRunId)).toBe("Running");
    expect(resumed).toEqual([parentRunId]);
  });

  it("(ADR-165) run.failed{reason:result_missing} wakes the parent UNCONDITIONALLY, pending sibling and all", async () => {
    const parentRunId = await seedParkedOrchestrator();

    await seedFlowChild({ parentRunId, status: "Running" });

    const { event } = await seedFlowChild({
      parentRunId,
      status: "Failed",
      emit: "run.failed",
      payload: { reason: "result_missing", resultStatus: "missing" },
    });

    const resumed: string[] = [];
    const consumer = buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId) => {
        resumed.push(runId);
      },
    });

    await consumer.handle([event!]);

    expect(await statusOf(parentRunId)).toBe("Running");
    expect(resumed).toEqual([parentRunId]);
  });
});
