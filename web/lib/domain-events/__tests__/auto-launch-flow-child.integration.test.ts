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
  ctx = await resetDelegationFixture({ pool, db, agentsRoot });
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
