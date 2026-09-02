import type { DomainEventRow } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { schema } from "@/test-support/graph-run-seed";
import {
  type DelegationSeedCtx,
  resetDelegationFixture,
  seedAgent,
  seedChildRun,
  seedFlow,
  seedTask,
} from "@/test-support/delegation-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-163 REQ-09/REQ-14/REQ-15/REQ-19/REQ-20: the as-plan machinery had a hard
// `payload.runKind !== "agent"` skip, so a FLOW child in a DAG would never
// auto-promote, never advance its task, and never release its dependents. This
// pins the widened behaviour AND the parts that must NOT widen.

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;
let ctx: DelegationSeedCtx;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
// The REAL launcher is used by the admission-guard cases below, so the
// scheduler and the supervisor are stubbed at their own seams: the run row must
// land (that is where the guard runs) without an ACP session being spawned.
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
    promoteNextPending: vi.fn(async () => null),
  };
});
vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    checkSupervisorHealth: vi.fn(async () => ({ kind: "available" as const })),
    listSessions: vi.fn(async () => []),
  };
});

let buildAutoLaunchRunPlanConsumer: typeof import("@/lib/domain-events/auto-launch").buildAutoLaunchRunPlanConsumer;
let emitDomainEvent: typeof import("@/lib/domain-events/outbox").emitDomainEvent;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-autolaunch-"));
  testDatabase = await startMainPostgresTestDb({
    databaseName: "auto_launch_flow_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  ({ buildAutoLaunchRunPlanConsumer } = await import(
    "@/lib/domain-events/auto-launch"
  ));
  ({ emitDomainEvent } = await import("@/lib/domain-events/outbox"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

let parentRunId: string;
let orchestratorTaskId: string;
let flowId: string;

beforeEach(async () => {
  // A real git repo: the FLOW arm of the admission-guard cases below runs the
  // canonical launcher, which validates both branch refs against the project's
  // actual branch set before any git side-effect.
  ctx = await resetDelegationFixture({
    pool,
    db,
    agentsRoot,
    withGitRepo: true,
  });
  ({ flowId } = await seedFlow(ctx, { flowRefId: "delegated-flow" }));

  const orchestratorTask = await seedTask(ctx, { title: "orchestrator" });

  orchestratorTaskId = orchestratorTask.id;
  parentRunId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "status",
       "flow_version", "flow_revision", "current_step_id")
     VALUES ($1, 'flow', $2, $3, 'WaitingOnChildren', 'v1', 'rev', 'coordinate')`,
    [parentRunId, ctx.projectId, orchestratorTaskId],
  );
});

/** An as-plan task with the given delegation spec, linked under the orchestrator. */
async function seedAsPlanTask(args: {
  title: string;
  spec: Record<string, unknown>;
  flowId?: string | null;
}): Promise<string> {
  const task = await seedTask(ctx, {
    title: args.title,
    status: "Backlog",
    flowId: args.flowId ?? null,
  });

  await pool.query(
    `UPDATE "tasks" SET "launch_mode" = 'auto', "delegation_spec" = $2::jsonb WHERE "id" = $1`,
    [task.id, JSON.stringify(args.spec)],
  );

  const { addTaskRelation } = await import("@/lib/social/relations");

  await addTaskRelation(
    {
      projectId: ctx.projectId,
      fromTaskId: orchestratorTaskId,
      kind: "parent_of",
      toTaskId: task.id,
      actor: { type: "system", id: null },
    },
    db,
  );

  return task.id;
}

async function settle(args: {
  runId: string;
  taskId: string | null;
  kind: "run.done" | "run.review";
  runKind: "agent" | "flow";
  status: string;
}): Promise<DomainEventRow[]> {
  await emitDomainEvent({
    db,
    kind: args.kind,
    projectId: ctx.projectId,
    taskId: args.taskId,
    runId: args.runId,
    actor: { type: "system", id: null },
    parentRunId,
    payload: { runKind: args.runKind, status: args.status },
  });

  // Read the row back through DRIZZLE, not `pool.query`: a raw pg row is
  // snake_case, so `event.runId` / `event.taskId` would be `undefined` and the
  // consumer would skip on a shape problem while the test read it as a
  // behaviour result.
  return (await db
    .select()
    .from(schema.domainEvents)
    .where(
      and(
        eq(schema.domainEvents.runId, args.runId),
        eq(schema.domainEvents.kind, args.kind),
      ),
    )) as DomainEventRow[];
}

describe("auto_launch_run_plan with FLOW children (ADR-163)", () => {
  it("the run_kind gate is an ALLOW-LIST: flow passes, scratch is still rejected", async () => {
    const launched: string[] = [];
    const consumer = buildAutoLaunchRunPlanConsumer({
      db,
      launchFlow: (async (input: { taskId: string }) => {
        launched.push(input.taskId);

        return { runId: randomUUID(), status: "Pending" };
      }) as never,
      promote: (async () => ({ ok: true })) as never,
    });

    const dependencyTaskId = await seedAsPlanTask({
      title: "producer",
      spec: { kind: "agent", agentId: "test-pkg:worker" },
    });
    const dependentTaskId = await seedAsPlanTask({
      title: "flow dependent",
      spec: { kind: "flow", flowId },
      flowId,
    });
    const { addTaskRelation } = await import("@/lib/social/relations");

    await addTaskRelation(
      {
        projectId: ctx.projectId,
        fromTaskId: dependentTaskId,
        kind: "requires",
        toTaskId: dependencyTaskId,
        actor: { type: "system", id: null },
      },
      db,
    );

    const producerRunId = await seedChildRun(ctx, {
      parentRunId,
      runKind: "agent",
      status: "Done",
      taskId: dependencyTaskId,
    });

    // A SCRATCH settle must not enter the as-plan machinery at all.
    const scratchRunId = await seedChildRun(ctx, {
      parentRunId,
      runKind: "agent",
      status: "Done",
    });

    await pool.query(
      `UPDATE "runs" SET "run_kind" = 'scratch' WHERE "id" = $1`,
      [scratchRunId],
    );
    await consumer.handle(
      await settle({
        runId: scratchRunId,
        taskId: null,
        kind: "run.done",
        runKind: "agent",
        status: "Done",
      }).then((rows) =>
        rows.map((r) => ({ ...r, payload: { runKind: "scratch" } })),
      ),
    );

    expect(launched).toHaveLength(0);

    // The AGENT producer's Done releases the FLOW dependent — the whole point.
    await consumer.handle(
      await settle({
        runId: producerRunId,
        taskId: dependencyTaskId,
        kind: "run.done",
        runKind: "agent",
        status: "Done",
      }),
    );

    expect(launched).toEqual([dependentTaskId]);

    const producerTask = (
      await pool.query(`SELECT "status" FROM "tasks" WHERE "id" = $1`, [
        dependencyTaskId,
      ])
    ).rows[0];

    expect(producerTask.status).toBe("Done");
  }, 60_000);

  // ADR-163 review S7: a TYPED refusal at release time (the flow was disabled,
  // untrusted or upgraded to an incompatible revision after run_plan) used to be
  // a logged skip and nothing else — the dependent DAG stalled with no trace on
  // the task. The refusal is now posted as a system comment (once per distinct
  // refusal); the task stays Backlog / launch_mode=auto so an admin fix is
  // picked up on the next sibling settle.
  it("a FLOW dependent refused at release time gets ONE system comment naming the refusal and stays queued", async () => {
    const { flowId: untrustedFlowId } = await seedFlow(ctx, {
      flowRefId: "untrusted-flow",
      trustStatus: "untrusted",
    });
    const dependencyTaskId = await seedAsPlanTask({
      title: "producer",
      spec: { kind: "agent", agentId: "test-pkg:worker" },
    });
    const dependentTaskId = await seedAsPlanTask({
      title: "flow dependent",
      spec: { kind: "flow", flowId: untrustedFlowId },
      flowId: untrustedFlowId,
    });
    const { addTaskRelation } = await import("@/lib/social/relations");

    await addTaskRelation(
      {
        projectId: ctx.projectId,
        fromTaskId: dependentTaskId,
        kind: "requires",
        toTaskId: dependencyTaskId,
        actor: { type: "system", id: null },
      },
      db,
    );

    const producerRunId = await seedChildRun(ctx, {
      parentRunId,
      runKind: "agent",
      status: "Done",
      taskId: dependencyTaskId,
    });
    const launched: string[] = [];
    const consumer = buildAutoLaunchRunPlanConsumer({
      db,
      launchFlow: (async (input: { taskId: string }) => {
        launched.push(input.taskId);

        return { runId: randomUUID(), status: "Pending" };
      }) as never,
      promote: (async () => ({ ok: true })) as never,
    });
    const events = await settle({
      runId: producerRunId,
      taskId: dependencyTaskId,
      kind: "run.done",
      runKind: "agent",
      status: "Done",
    });

    // At-least-once contract: a refusal is never thrown out of the consumer.
    await expect(consumer.handle(events)).resolves.toBeUndefined();

    expect(launched).toEqual([]);

    const task = (
      await pool.query(
        `SELECT "status", "launch_mode" FROM "tasks" WHERE "id" = $1`,
        [dependentTaskId],
      )
    ).rows[0];

    expect(task).toEqual({ status: "Backlog", launch_mode: "auto" });

    const comments = async () =>
      (
        await pool.query(
          `SELECT "body" FROM "task_comments" WHERE "task_id" = $1 ORDER BY "created_at"`,
          [dependentTaskId],
        )
      ).rows as { body: string }[];

    const first = await comments();

    expect(first).toHaveLength(1);
    expect(first[0].body).toContain("PRECONDITION");
    expect(first[0].body).toContain("not trusted");

    // A redelivered window (same refusal) does not post a second identical comment.
    await consumer.handle(events);

    expect(await comments()).toHaveLength(1);
  }, 60_000);

  it("a FLOW child's run.review auto-promotes an as-plan (auto) child", async () => {
    const promoted: string[] = [];
    const consumer = buildAutoLaunchRunPlanConsumer({
      db,
      // `promote` takes the child run id POSITIONALLY (promoteChildRunForToken's
      // own signature), so the spy reads arg 0.
      promote: (async (childRunId: string) => {
        promoted.push(childRunId);

        return { ok: true };
      }) as never,
    });

    const taskId = await seedAsPlanTask({
      title: "auto flow child",
      spec: { kind: "flow", flowId },
      flowId,
    });
    const childRunId = await seedChildRun(ctx, {
      parentRunId,
      runKind: "flow",
      status: "Review",
      taskId,
      flowId,
    });

    await pool.query(
      `UPDATE "runs" SET "launch_mode" = 'auto' WHERE "id" = $1`,
      [childRunId],
    );

    await consumer.handle(
      await settle({
        runId: childRunId,
        taskId,
        kind: "run.review",
        runKind: "flow",
        status: "Review",
      }),
    );

    expect(promoted).toEqual([childRunId]);
  }, 60_000);

  it("a MANUAL (as-run) flow child in Review is NOT auto-promoted — the launch_mode discriminant", async () => {
    const promoted: string[] = [];
    const consumer = buildAutoLaunchRunPlanConsumer({
      db,
      // `promote` takes the child run id POSITIONALLY (promoteChildRunForToken's
      // own signature), so the spy reads arg 0.
      promote: (async (childRunId: string) => {
        promoted.push(childRunId);

        return { ok: true };
      }) as never,
    });

    const taskId = await seedAsPlanTask({
      title: "manual flow child",
      spec: { kind: "flow", flowId },
      flowId,
    });
    const childRunId = await seedChildRun(ctx, {
      parentRunId,
      runKind: "flow",
      status: "Review",
      taskId,
      flowId,
    });

    // seedChildRun stamps launch_mode='manual' — an as-RUN child, whose
    // promote decision belongs to the live coordinator.
    await consumer.handle(
      await settle({
        runId: childRunId,
        taskId,
        kind: "run.review",
        runKind: "flow",
        status: "Review",
      }),
    );

    expect(promoted).toEqual([]);
    expect(
      (
        await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [
          childRunId,
        ])
      ).rows[0].status,
    ).toBe("Review");
  }, 60_000);

  // REQ-20: `Review` is not "safe to ship". A conflicting auto-promote leaves
  // the child in Review, flips no sibling, and is never auto-resolved.
  it("an auto flow child whose promote CONFLICTS stays in Review and releases nothing", async () => {
    const consumer = buildAutoLaunchRunPlanConsumer({
      db,
      promote: (async () => {
        const { MaisterError } = await import("@/lib/errors");

        throw new MaisterError("CONFLICT", "merge conflict");
      }) as never,
    });

    const producerTaskId = await seedAsPlanTask({
      title: "conflicting producer",
      spec: { kind: "flow", flowId },
      flowId,
    });
    const dependentTaskId = await seedAsPlanTask({
      title: "blocked dependent",
      spec: { kind: "agent", agentId: "test-pkg:worker" },
    });
    const { addTaskRelation } = await import("@/lib/social/relations");

    await addTaskRelation(
      {
        projectId: ctx.projectId,
        fromTaskId: dependentTaskId,
        kind: "requires",
        toTaskId: producerTaskId,
        actor: { type: "system", id: null },
      },
      db,
    );

    const childRunId = await seedChildRun(ctx, {
      parentRunId,
      runKind: "flow",
      status: "Review",
      taskId: producerTaskId,
      flowId,
    });

    await pool.query(
      `UPDATE "runs" SET "launch_mode" = 'auto' WHERE "id" = $1`,
      [childRunId],
    );

    // The consumer is idempotent: a promote refusal is logged, never thrown —
    // a throw would redeliver the whole window forever.
    await expect(
      consumer.handle(
        await settle({
          runId: childRunId,
          taskId: producerTaskId,
          kind: "run.review",
          runKind: "flow",
          status: "Review",
        }),
      ),
    ).resolves.toBeUndefined();

    expect(
      (
        await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [
          childRunId,
        ])
      ).rows[0].status,
    ).toBe("Review");

    // The producer task never reached Done, so the dependent stays blocked.
    expect(
      (
        await pool.query(`SELECT "status" FROM "tasks" WHERE "id" = $1`, [
          producerTaskId,
        ])
      ).rows[0].status,
    ).not.toBe("Done");
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM "runs" WHERE "task_id" = $1`,
          [dependentTaskId],
        )
      ).rows[0].n,
    ).toBe(0);
  }, 60_000);
});

// ADR-163 REQ-15 — the third child-creation edge.
//
// `run_delegate` and `run_plan` call `admitDelegatedChild` at the route, but the
// as-plan auto-launcher never did: it is guarded because the bound is ALSO taken
// inside the launcher's own run-insert transaction, and this consumer's default
// bindings are the real launchers (`opts.launch ?? launchAgentRun`,
// `opts.launchFlow ?? launchRun`).
//
// Every OTHER case in this file injects those launchers, which bypasses the
// guard entirely — so without this describe block the claim "the auto-launch
// edge is guarded" rests on reading one line of wiring. These cases build the
// consumer with NO launcher injection so the REAL launcher runs, and assert the
// cap actually bites there.
describe("the as-plan auto-launcher is bounded by the shared cap (ADR-163 REQ-15)", () => {
  afterEach(() => {
    delete process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;
  });

  /**
   * A producer task that has just gone Done, plus an as-plan dependent gated on
   * it by `requires`. Returns the dependent's task id and the settled event.
   */
  async function seedReleasableDependent(
    spec: Record<string, unknown>,
    dependentFlowId: string | null,
  ): Promise<{ dependentTaskId: string; events: DomainEventRow[] }> {
    const producerTaskId = await seedAsPlanTask({
      title: "producer",
      spec: { kind: "agent", agentId: "test-pkg:worker" },
    });
    const dependentTaskId = await seedAsPlanTask({
      title: "dependent",
      spec,
      flowId: dependentFlowId,
    });
    const { addTaskRelation } = await import("@/lib/social/relations");

    await addTaskRelation(
      {
        projectId: ctx.projectId,
        fromTaskId: dependentTaskId,
        kind: "requires",
        toTaskId: producerTaskId,
        actor: { type: "system", id: null },
      },
      db,
    );

    const producerRunId = await seedChildRun(ctx, {
      parentRunId,
      runKind: "agent",
      status: "Done",
      taskId: producerTaskId,
    });

    await pool.query(
      `UPDATE "runs" SET "launch_mode" = 'auto' WHERE "id" = $1`,
      [producerRunId],
    );

    return {
      dependentTaskId,
      events: await settle({
        runId: producerRunId,
        taskId: producerTaskId,
        kind: "run.done",
        runKind: "agent",
        status: "Done",
      }),
    };
  }

  async function runsForTask(taskId: string): Promise<number> {
    return (
      await pool.query(
        `SELECT count(*)::int AS n FROM "runs" WHERE "task_id" = $1`,
        [taskId],
      )
    ).rows[0].n;
  }

  it("refuses a released dependent at the cap through the REAL launcher, and admits it once a slot frees", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "2";

    // The auto-launcher's trigger is `domain_event`; the launcher refuses a
    // trigger the definition does not declare, and that refusal would make the
    // at-cap assertion below pass for the WRONG reason.
    await seedAgent(ctx, {
      id: "worker",
      triggers: ["manual", "domain_event"],
    });

    // Two live children already fill the cap. Neither is the dependent.
    const hog = await seedChildRun(ctx, {
      parentRunId,
      runKind: "agent",
      status: "Running",
    });

    await seedChildRun(ctx, {
      parentRunId,
      runKind: "flow",
      status: "Review",
      flowId,
    });

    const { dependentTaskId, events } = await seedReleasableDependent(
      { kind: "agent", agentId: "test-pkg:worker" },
      null,
    );

    // NO launcher injection — `opts.launch` defaults to the real launchAgentRun,
    // whose run-insert transaction is where admitDelegatedChild runs.
    const consumer = buildAutoLaunchRunPlanConsumer({ db });

    // The consumer's contract is idempotent: a refusal is a logged skip, never a
    // throw — a throw would redeliver this window forever.
    await expect(consumer.handle(events)).resolves.toBeUndefined();

    expect(await runsForTask(dependentTaskId)).toBe(0);

    // Free a slot and re-deliver. The dependent now launches, which proves the
    // refusal above was the CAP and not a broken fixture — without this half the
    // first assertion would pass on any failure at all.
    await pool.query(`UPDATE "runs" SET "status" = 'Done' WHERE "id" = $1`, [
      hog,
    ]);
    await expect(consumer.handle(events)).resolves.toBeUndefined();

    expect(await runsForTask(dependentTaskId)).toBe(1);

    const launched = (
      await pool.query(
        `SELECT "run_kind", "parent_run_id", "launch_mode" FROM "runs" WHERE "task_id" = $1`,
        [dependentTaskId],
      )
    ).rows[0];

    expect(launched.run_kind).toBe("agent");
    expect(launched.parent_run_id).toBe(parentRunId);
    expect(launched.launch_mode).toBe("auto");
  }, 60_000);

  it("the same bound applies to a FLOW dependent through the real flow launcher", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "1";

    await seedAgent(ctx, { id: "worker" });

    const hog = await seedChildRun(ctx, {
      parentRunId,
      runKind: "flow",
      status: "Running",
      flowId,
    });
    const { dependentTaskId, events } = await seedReleasableDependent(
      { kind: "flow", flowId },
      flowId,
    );
    const consumer = buildAutoLaunchRunPlanConsumer({ db });

    await expect(consumer.handle(events)).resolves.toBeUndefined();
    expect(await runsForTask(dependentTaskId)).toBe(0);

    await pool.query(`UPDATE "runs" SET "status" = 'Done' WHERE "id" = $1`, [
      hog,
    ]);
    await expect(consumer.handle(events)).resolves.toBeUndefined();

    expect(await runsForTask(dependentTaskId)).toBe(1);
    expect(
      (
        await pool.query(
          `SELECT "run_kind" FROM "runs" WHERE "task_id" = $1`,
          [dependentTaskId],
        )
      ).rows[0].run_kind,
    ).toBe("flow");
  }, 60_000);
});
