import type { DomainEventRow } from "@/lib/db/schema";

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
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

import {
  countRows,
  delegateRequest,
  type DelegationSeedCtx,
  resetDelegationFixture,
  seedAgent,
  seedChildRun,
  seedFlow,
  seedOrchestratorRun,
  seedTask,
} from "@/test-support/delegation-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;
let ctx: DelegationSeedCtx;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
// The scheduler is stubbed so no agent/flow session is ever spawned: the run row
// stays a stable `Pending` with every delegation column set at INSERT, which is
// what these cases are about. The one case that needs real admission behaviour
// drives `promoteNextPending` explicitly through the unmocked import.
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
    deleteSession: vi.fn(async () => undefined),
  };
});

let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
let delegatePost: typeof import("@/app/api/v1/ext/runs/delegate/route").POST;
let reworkPost: typeof import("@/app/api/v1/ext/runs/rework/route").POST;
let messagePost: typeof import("@/app/api/v1/ext/runs/message/route").POST;
let promotePost: typeof import("@/app/api/v1/ext/runs/promote/route").POST;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-deleg-flow-"));
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_delegate_flow_arm_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
  ({ POST: delegatePost } = await import(
    "@/app/api/v1/ext/runs/delegate/route"
  ));
  ({ POST: reworkPost } = await import("@/app/api/v1/ext/runs/rework/route"));
  ({ POST: messagePost } = await import("@/app/api/v1/ext/runs/message/route"));
  ({ POST: promotePost } = await import("@/app/api/v1/ext/runs/promote/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

let orchestratorTaskId: string;
let parentRunId: string;
let secret: string;
let flowId: string;

beforeEach(async () => {
  ctx = await resetDelegationFixture({
    pool,
    db,
    agentsRoot,
    withGitRepo: true,
  });

  ({ flowId } = await seedFlow(ctx, { flowRefId: "delegated-flow" }));

  const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
  const task = await seedTask(ctx);

  orchestratorTaskId = task.id;
  ({ runId: parentRunId, secret } = await seedOrchestratorRun(ctx, {
    orchestratorAgentId: orchestrator,
    taskId: task.id,
    issueToken: issueOrchestratorRunToken,
  }));
});

afterEach(() => {
  delete process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;
  vi.restoreAllMocks();
});

function flowDelegation(overrides: Record<string, unknown> = {}) {
  return {
    target: { flowId: "delegated-flow" },
    mode: "run",
    prompt: "Fix the failing collect endpoint",
    ...overrides,
  };
}

async function childRun(runId: string) {
  return (
    await pool.query(
      `SELECT "run_kind", "task_id", "flow_id", "flow_revision_id", "status",
              "parent_run_id", "root_run_id", "launch_mode", "delegation_snapshot"
         FROM "runs" WHERE "id" = $1`,
      [runId],
    )
  ).rows[0];
}

describe("run_delegate flow arm (ADR-163 REQ-07..REQ-13)", () => {
  it.each(["task", "run"] as const)(
    "mode:%s → a carrier task, a parent_of edge, and a governed flow child",
    async (mode) => {
      const res = await delegatePost(
        delegateRequest(secret, flowDelegation({ mode, title: "Fix collect" })),
        {},
      );

      expect(res.status).toBe(202);
      const json = (await res.json()) as {
        childRunId: string;
        childTaskId?: string;
      };

      // D1: BOTH modes mint and link a carrier task, and `childTaskId` is
      // always returned for a flow target — `mode` is not a board switch here.
      expect(json.childTaskId).toBeTruthy();

      const carrier = (
        await pool.query(
          `SELECT "title", "prompt", "flow_id", "launch_mode", "status"
             FROM "tasks" WHERE "id" = $1`,
          [json.childTaskId],
        )
      ).rows[0];

      // REQ-11: the carrier task carries the SELECTED flow, never the
      // orchestrator's (which is NULL in this fixture — an inherited value
      // would show up as null and the assertion would catch it).
      expect(carrier.flow_id).toBe(flowId);
      expect(carrier.title).toBe("Fix collect");
      expect(carrier.prompt).toBe("Fix the failing collect endpoint");
      expect(carrier.launch_mode).toBe("manual");

      const rel = (
        await pool.query(
          `SELECT "kind", "to_task_id" FROM "task_relations" WHERE "from_task_id" = $1`,
          [orchestratorTaskId],
        )
      ).rows;

      expect(rel).toHaveLength(1);
      expect(rel[0].kind).toBe("parent_of");
      expect(rel[0].to_task_id).toBe(json.childTaskId);

      const child = await childRun(json.childRunId);

      expect(child.run_kind).toBe("flow");
      expect(child.task_id).toBe(json.childTaskId);
      expect(child.flow_id).toBe(flowId);
      expect(child.flow_revision_id).toBeTruthy();
      expect(child.parent_run_id).toBe(parentRunId);
      expect(child.root_run_id).toBe(parentRunId);
      expect(child.launch_mode).toBe("manual");
      expect(child.delegation_snapshot).toMatchObject({
        kind: "flow",
        flowId,
        flowRefId: "delegated-flow",
        carrierTaskId: json.childTaskId,
        mode,
        runnerOverride: null,
        baseBranch: "main",
        targetBranch: "main",
      });
    },
  );

  it("defaults the carrier title to the prompt's first line", async () => {
    const res = await delegatePost(
      delegateRequest(
        secret,
        flowDelegation({ prompt: "First line\nsecond line" }),
      ),
      {},
    );

    expect(res.status).toBe(202);
    const { childTaskId } = (await res.json()) as { childTaskId: string };

    const title = (
      await pool.query(`SELECT "title" FROM "tasks" WHERE "id" = $1`, [
        childTaskId,
      ])
    ).rows[0].title;

    expect(title).toBe("First line");
  });

  // REQ-13: `runnerOverride` reaches the FLOW executor-resolution chain, so an
  // unknown runner surfaces THAT chain's own error rather than a bespoke one —
  // and, being a launch-time failure, it triggers the carrier compensation.
  it("an unknown runnerOverride surfaces the flow runner chain's own refusal and leaves no carrier task", async () => {
    const tasksBefore = await countRows(ctx, "tasks");

    const res = await delegatePost(
      delegateRequest(
        secret,
        flowDelegation({ runnerOverride: "no-such-runner" }),
      ),
      {},
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await countRows(ctx, "runs")).toBe(1); // the orchestrator only
    expect(await countRows(ctx, "tasks")).toBe(tasksBefore);
  });

  it("REQ-17: a flow child draws the FLOW pool while an agent sibling draws the AGENT pool", async () => {
    const { poolForRunKind } = await import("@/lib/scheduler");

    expect(poolForRunKind("flow")).toBe("flow");
    expect(poolForRunKind("agent")).toBe("agent");

    const res = await delegatePost(
      delegateRequest(secret, flowDelegation()),
      {},
    );

    expect(res.status).toBe(202);
    const { childRunId } = (await res.json()) as { childRunId: string };

    // tryStartRun is stubbed to refuse the slot, so the child parks Pending —
    // the state W4's recovery path (promoteNextPending on the flow pool) picks
    // up. The point here is that the row is a `flow` run, so it is the FLOW
    // budget it will be admitted against.
    const child = await childRun(childRunId);

    expect(child.status).toBe("Pending");
    expect(child.run_kind).toBe("flow");
  });
});

describe("run_delegate flow arm — failure and crash windows (ADR-163 REQ-21)", () => {
  // W2: the carrier transaction committed, then the launch threw. The
  // compensation must cover the ENTIRE fallible remainder, not a tail.
  it("W2: a launch failure after the carrier transaction removes the carrier task AND its relation", async () => {
    // Point the project at a path that is not a git repo, so `launchRunStaged`
    // throws AFTER the carrier task committed. This is a real failure mode
    // (a moved/deleted checkout), not an injected stub.
    await pool.query(`UPDATE "projects" SET "repo_path" = $2 WHERE "id" = $1`, [
      ctx.projectId,
      `/nonexistent/${randomUUID()}`,
    ]);

    const tasksBefore = await countRows(ctx, "tasks");
    const relationsBefore = await countRows(ctx, "task_relations");

    const res = await delegatePost(
      delegateRequest(secret, flowDelegation()),
      {},
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await countRows(ctx, "tasks")).toBe(tasksBefore);
    expect(await countRows(ctx, "task_relations")).toBe(relationsBefore);
  });

  // W6: the orchestrator terminalized between the pre-flight check and the
  // committed child. Its own cascade already ran, so nothing else would ever
  // reach this child.
  it("W6: a parent that terminalizes during the launch leaves the child Abandoned and returns PRECONDITION", async () => {
    const { POST: realDelegatePost } = await import(
      "@/app/api/v1/ext/runs/delegate/route"
    );
    const runsModule = await import("@/lib/services/runs");
    const realLaunch = runsModule.launchRun;

    // Terminalize the parent INSIDE the launch, i.e. exactly in the window the
    // post-commit re-read exists to cover.
    const spy = vi
      .spyOn(runsModule, "launchRun")
      .mockImplementation(async (input, launchCtx, injectedDb) => {
        const out = await realLaunch(input, launchCtx, injectedDb);

        await pool.query(
          `UPDATE "runs" SET "status" = 'Abandoned' WHERE "id" = $1`,
          [parentRunId],
        );

        return out;
      });

    try {
      const res = await realDelegatePost(
        delegateRequest(secret, flowDelegation()),
        {},
      );

      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe(
        "PRECONDITION",
      );

      const child = (
        await pool.query(
          `SELECT "status" FROM "runs" WHERE "parent_run_id" = $1`,
          [parentRunId],
        )
      ).rows[0];

      expect(child.status).toBe("Abandoned");
    } finally {
      spy.mockRestore();
    }
  });

  // W3: process death BETWEEN the carrier transaction and the run transaction.
  // Nothing compensates (the process is gone), so the residual is a visible
  // Backlog card — and the claim that makes it harmless is that NO discovery
  // query selects it. That claim is what this pins.
  it("W3: an orphaned carrier task is a harmless Backlog card no automation claims", async () => {
    // Reproduce the exact row the carrier transaction commits, then stop —
    // as if the process died before launchRunStaged ran.
    const carrier = await seedTask(ctx, {
      title: "orphaned carrier",
      status: "Backlog",
      flowId,
    });

    await pool.query(
      `UPDATE "tasks" SET "launch_mode" = 'manual', "delegation_spec" = $2::jsonb WHERE "id" = $1`,
      [carrier.id, JSON.stringify({ kind: "flow", flowId })],
    );

    const { addTaskRelation } = await import("@/lib/social/relations");

    await addTaskRelation(
      {
        projectId: ctx.projectId,
        fromTaskId: orchestratorTaskId,
        kind: "parent_of",
        toTaskId: carrier.id,
        actor: { type: "system", id: null },
      },
      db,
    );

    // The as-plan auto-launcher is the ONE automation that launches a task
    // nobody clicked. Drive it with a settled sibling event — the shape that
    // makes it look for unblocked dependents.
    const { emitDomainEvent } = await import("@/lib/domain-events/outbox");
    const { buildAutoLaunchRunPlanConsumer } = await import(
      "@/lib/domain-events/auto-launch"
    );
    const siblingRunId = await seedChildRun(ctx, {
      parentRunId,
      runKind: "agent",
      status: "Done",
    });

    await emitDomainEvent({
      db,
      kind: "run.done",
      projectId: ctx.projectId,
      runId: siblingRunId,
      actor: { type: "system", id: null },
      parentRunId,
      payload: { runKind: "agent", status: "Done" },
    });

    const events = (
      await pool.query(`SELECT * FROM "domain_events" WHERE "run_id" = $1`, [
        siblingRunId,
      ])
    ).rows;
    const runsBefore = await countRows(ctx, "runs");

    await buildAutoLaunchRunPlanConsumer({ db }).handle(events);

    // `launch_mode='manual'` excludes it from the as-plan discovery query, so
    // no run appeared and the card is still sitting in Backlog for a human.
    expect(await countRows(ctx, "runs")).toBe(runsBefore);

    const still = (
      await pool.query(
        `SELECT "status", "launch_mode" FROM "tasks" WHERE "id" = $1`,
        [carrier.id],
      )
    ).rows[0];

    expect(still.status).toBe("Backlog");
    expect(still.launch_mode).toBe("manual");
  }, 60_000);

  // W5: the child's background `runFlow` died (process death, session spawn
  // failure). The recovery is the EXISTING reconcile classifier, and this pins
  // the whole chain: flow arm reached -> Crashed -> run.crashed carrying
  // parentRunId -> the parked parent wakes. Without the parentRunId on the emit
  // the parent would sit in WaitingOnChildren forever.
  it("W5: a Running flow child with no live session reconciles to Crashed and wakes the parent", async () => {
    const res = await delegatePost(
      delegateRequest(secret, flowDelegation()),
      {},
    );
    const { childRunId } = (await res.json()) as { childRunId: string };

    await pool.query(
      `UPDATE "runs" SET "status" = 'Running', "started_at" = now() - interval '1 hour' WHERE "id" = $1`,
      [childRunId],
    );
    // Park the orchestrator the way the graph runner does: a FLOW run at an
    // `orchestrator` node with a ledger row — `orchestrator_resume` branches on
    // the PARENT's kind and reads the coordinator node type before it wakes
    // anything, so both are part of the fixture, not incidental.
    await pool.query(
      `UPDATE "runs" SET "run_kind" = 'flow', "flow_id" = $2, "agent_id" = NULL,
                         "status" = 'WaitingOnChildren', "current_step_id" = 'coordinate'
        WHERE "id" = $1`,
      [parentRunId, flowId],
    );
    await pool.query(
      `INSERT INTO "node_attempts" ("id", "run_id", "node_id", "node_type", "attempt", "status")
       VALUES ($1, $2, 'coordinate', 'orchestrator', 1, 'NeedsInput')`,
      [randomUUID(), parentRunId],
    );

    const { runReconcileSweep } = await import("@/lib/reconcile");

    await runReconcileSweep({
      db,
      listSessions: async () => [],
      deleteSession: async () => undefined,
      listWorktrees: async () => [],
      runFlow: async () => undefined,
    });

    expect((await childRun(childRunId)).status).toBe("Crashed");

    const crashed = (
      await pool.query(
        `SELECT "payload" FROM "domain_events" WHERE "run_id" = $1 AND "kind" = 'run.crashed'`,
        [childRunId],
      )
    ).rows;

    expect(crashed).toHaveLength(1);
    expect((crashed[0].payload as { parentRunId: string }).parentRunId).toBe(
      parentRunId,
    );

    const { buildOrchestratorResumeConsumer } = await import(
      "@/lib/domain-events/orchestrator-resume"
    );
    // Read through DRIZZLE: a raw pg row is snake_case, so a consumer reading
    // `event.runId` / `event.taskId` would silently see `undefined`.
    const { schema } = await import("@/test-support/graph-run-seed");
    const { and, eq } = await import("drizzle-orm");
    const [event] = await db
      .select()
      .from(schema.domainEvents)
      .where(
        and(
          eq(schema.domainEvents.runId, childRunId),
          eq(schema.domainEvents.kind, "run.crashed"),
        ),
      );
    const resumed: string[] = [];

    await buildOrchestratorResumeConsumer({
      db,
      resumeFlow: async (runId: string) => {
        resumed.push(runId);
      },
    }).handle([event as unknown as DomainEventRow]);

    expect(resumed).toEqual([parentRunId]);
    expect((await childRun(parentRunId)).status).toBe("Running");
  }, 60_000);

  // W7: at-least-once MCP redelivery. Accepted residual (D6) — two children,
  // both visible, bounded by the shared cap. Pinned so a future change that
  // silently dedups (or silently stops bounding) fails loudly.
  it("W7: a duplicate delegation produces a SECOND governed child, and the cap still bites", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "2";

    const first = await delegatePost(
      delegateRequest(secret, flowDelegation()),
      {},
    );
    const second = await delegatePost(
      delegateRequest(secret, flowDelegation()),
      {},
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const children = (
      await pool.query(`SELECT "id" FROM "runs" WHERE "parent_run_id" = $1`, [
        parentRunId,
      ])
    ).rows;

    expect(children).toHaveLength(2);

    // At the bound the third is refused — the residual is bounded, not open.
    const third = await delegatePost(
      delegateRequest(secret, flowDelegation()),
      {},
    );

    expect(third.status).toBe(422);
    expect(((await third.json()) as { code: string }).code).toBe("CONFIG");
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM "runs" WHERE "parent_run_id" = $1`,
          [parentRunId],
        )
      ).rows[0].n,
    ).toBe(2);
  });

  // W11: after the orchestrator is abandoned, its carrier TASKS survive their
  // abandoned RUNS and read as launchable. Accepted because no automation can
  // fire them — this pins BOTH halves so a change to either is loud.
  it("W11: an abandoned orchestrator leaves carrier tasks launchable, and no automation claims them", async () => {
    const res = await delegatePost(
      delegateRequest(secret, flowDelegation()),
      {},
    );

    expect(res.status).toBe(202);
    const { childTaskId, childRunId } = (await res.json()) as {
      childTaskId: string;
      childRunId: string;
    };

    const { cascadeAbandonRunTree } = await import(
      "@/lib/orchestrator/cascade"
    );

    await cascadeAbandonRunTree(
      parentRunId,
      orchestratorTaskId,
      "user_stopped",
      { db },
    );

    const child = await childRun(childRunId);

    expect(child.status).toBe("Abandoned");

    const carrier = (
      await pool.query(
        `SELECT "status", "launch_mode" FROM "tasks" WHERE "id" = $1`,
        [childTaskId],
      )
    ).rows[0];

    // The cascade abandons RUNS; a carrier task is `manual` AND has a run, so
    // `getUnlaunchedAutoChildTaskIds` (auto + no run) never selects it.
    expect(carrier.status).not.toBe("Abandoned");
    expect(carrier.launch_mode).toBe("manual");

    const { getUnlaunchedAutoChildTaskIds } = await import("@/lib/queries/run");
    const claimable = await getUnlaunchedAutoChildTaskIds(
      orchestratorTaskId,
      db as never,
    );

    expect(claimable).not.toContain(childTaskId);

    const { classifyManualTaskLaunchability } = await import(
      "@/lib/runs/launchability"
    );

    expect(
      classifyManualTaskLaunchability(
        { status: carrier.status, triageStatus: null },
        { status: "Abandoned" },
      ),
    ).toBe("launchable");
  });

  // W12: an orchestrator that exits NORMALLY does not cascade, so an
  // un-promoted flow child parks in Review holding its worktree.
  it("W12: a Review child of a normally-finished orchestrator is not reclaimed", async () => {
    const res = await delegatePost(
      delegateRequest(secret, flowDelegation()),
      {},
    );

    expect(res.status).toBe(202);
    const { childRunId } = (await res.json()) as { childRunId: string };

    await pool.query(`UPDATE "runs" SET "status" = 'Review' WHERE "id" = $1`, [
      childRunId,
    ]);
    // The orchestrator's NORMAL exit: terminal, no cascade.
    await pool.query(`UPDATE "runs" SET "status" = 'Done' WHERE "id" = $1`, [
      parentRunId,
    ]);

    const child = await childRun(childRunId);

    expect(child.status).toBe("Review");

    const { isDisposableWorkspaceRunStatus } = await import(
      "@/lib/runs/run-status-sets"
    );

    // GC only collects Done/Abandoned, so the worktree is retained...
    expect(isDisposableWorkspaceRunStatus("Review")).toBe(false);

    const workspace = (
      await pool.query(
        `SELECT "removed_at" FROM "workspaces" WHERE "run_id" = $1`,
        [childRunId],
      )
    ).rows[0];

    expect(workspace.removed_at).toBeNull();

    // ...while holding no scheduler slot (countLiveRuns excludes Review).
    const { countLiveRuns } = await import("@/lib/scheduler");

    expect(await countLiveRuns(db as never, "flow")).toBe(0);
  });

  // W10 / REQ-19: the parent's cancellation cascade must reach BOTH child kinds
  // in one transaction, emit a routable terminal for each, release each
  // workspace, and reclaim a slot from EACH pool the tree was drawing on.
  it("W10: the cancel cascade abandons an agent child AND a flow child, per-pool", async () => {
    const scheduler = await import("@/lib/scheduler");

    vi.mocked(scheduler.promoteNextPending).mockClear();

    const flowRes = await delegatePost(
      delegateRequest(secret, flowDelegation()),
      {},
    );
    const { childRunId: flowChildId } = (await flowRes.json()) as {
      childRunId: string;
    };

    await pool.query(`UPDATE "runs" SET "status" = 'Review' WHERE "id" = $1`, [
      flowChildId,
    ]);

    const worker = await seedAgent(ctx, { id: "worker" });
    const agentRes = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "agent sibling",
      }),
      {},
    );
    const { childRunId: agentChildId } = (await agentRes.json()) as {
      childRunId: string;
    };

    await pool.query(`UPDATE "runs" SET "status" = 'Running' WHERE "id" = $1`, [
      agentChildId,
    ]);

    const { cascadeAbandonRunTree } = await import(
      "@/lib/orchestrator/cascade"
    );
    const result = await cascadeAbandonRunTree(
      parentRunId,
      orchestratorTaskId,
      "user_stopped",
      { db },
    );

    expect(result.cascadedRunIds.sort()).toEqual(
      [agentChildId, flowChildId].sort(),
    );
    expect((await childRun(flowChildId)).status).toBe("Abandoned");
    expect((await childRun(agentChildId)).status).toBe("Abandoned");

    // A routable terminal for EACH — without parentRunId a grandparent would
    // never learn the sub-tree collapsed.
    for (const runId of [flowChildId, agentChildId]) {
      const events = (
        await pool.query(
          `SELECT "payload" FROM "domain_events" WHERE "run_id" = $1 AND "kind" = 'run.abandoned'`,
          [runId],
        )
      ).rows;

      expect(events).toHaveLength(1);
      expect((events[0].payload as { parentRunId: string }).parentRunId).toBe(
        parentRunId,
      );
    }

    // The flow child provisioned a worktree, so its workspace is scheduled for
    // removal; the agent child's `workspace: none` provisions none.
    const flowWorkspace = (
      await pool.query(
        `SELECT "scheduled_removal_at" FROM "workspaces" WHERE "run_id" = $1`,
        [flowChildId],
      )
    ).rows[0];

    expect(flowWorkspace.scheduled_removal_at).not.toBeNull();

    // Once per pool the tree actually held — a single global call would starve
    // whichever pool it did not name.
    const pools = vi
      .mocked(scheduler.promoteNextPending)
      .mock.calls.map(
        (call) => (call[0] as { pool?: string } | undefined)?.pool,
      )
      .filter(Boolean)
      .sort();

    expect(pools).toEqual(["agent", "flow"]);
  }, 60_000);
});

describe("run_delegate — the admission cap is shared across kinds at the route (ADR-163 D3)", () => {
  it("an AGENT delegation is refused once the orchestrator's live FLOW children fill the cap", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "1";

    await seedChildRun(ctx, {
      parentRunId,
      runKind: "flow",
      status: "Running",
      flowId,
    });

    const worker = await seedAgent(ctx, { id: "worker" });
    const runsBefore = await countRows(ctx, "runs");

    const res = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "one too many",
      }),
      {},
    );

    expect(res.status).toBe(422);
    const json = (await res.json()) as { code: string; message: string };

    expect(json.code).toBe("CONFIG");
    expect(json.message).toContain("fan-out limit reached");
    expect(await countRows(ctx, "runs")).toBe(runsBefore);
  });
});

describe("tool support by child kind (ADR-163 D2 / REQ-14)", () => {
  function extRequest(routePath: string, body: unknown) {
    const req = new NextRequest(`http://localhost${routePath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    req.headers.set("authorization", `Bearer ${secret}`);

    return req;
  }

  async function reviewFlowChild(): Promise<string> {
    const res = await delegatePost(
      delegateRequest(secret, flowDelegation()),
      {},
    );
    const { childRunId } = (await res.json()) as { childRunId: string };

    await pool.query(`UPDATE "runs" SET "status" = 'Review' WHERE "id" = $1`, [
      childRunId,
    ]);

    return childRunId;
  }

  it("run_rework on a flow child → PRECONDITION, and the child is UNTOUCHED", async () => {
    const childRunId = await reviewFlowChild();
    const before = await childRun(childRunId);

    const res = await reworkPost(
      extRequest("/api/v1/ext/runs/rework", {
        childRunId,
        prompt: "try again",
      }),
      {},
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; message: string };

    expect(json.code).toBe("PRECONDITION");
    expect(json.message).toContain("run_rework is not supported for flow");

    // A refusal is a ROUTING decision, not a state mutation: the child is still
    // exactly where it was, and its promotion state is untouched.
    const after = await childRun(childRunId);

    expect(after.status).toBe("Review");
    expect(after).toEqual(before);

    const promotionState = (
      await pool.query(
        `SELECT "promotion_state" FROM "workspaces" WHERE "run_id" = $1`,
        [childRunId],
      )
    ).rows[0];

    // `none` is the at-launch default; the point is that the refusal did not
    // advance it (to `claiming`/`done`).
    expect(promotionState.promotion_state).toBe("none");
  }, 60_000);

  it("run_message on a flow child → PRECONDITION naming the actual reason", async () => {
    const childRunId = await reviewFlowChild();

    const res = await messagePost(
      extRequest("/api/v1/ext/runs/message", {
        childRunId,
        prompt: "hello?",
      }),
      {},
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; message: string };

    expect(json.code).toBe("PRECONDITION");
    // Not the old blanket "no persistent child …", which was false: the child
    // exists, it just has no addressable agent session.
    expect(json.message).toContain("run_message is not supported for flow");
  }, 60_000);

  it("run_promote on the SAME child still reaches the promote service — the refusals are routing, not a block on the child", async () => {
    const childRunId = await reviewFlowChild();

    const res = await promotePost(
      extRequest("/api/v1/ext/runs/promote", { childRunId }),
      {},
    );

    // The child has no real merge base in this fixture, so the outcome is the
    // promote service's OWN result — the point is that `run_promote` is not
    // refused for being a flow child the way rework/message are.
    const json = (await res.json()) as { code?: string; message?: string };

    expect(json.code ?? "").not.toBe("PRECONDITION");
    expect(json.message ?? "").not.toContain("not supported for flow");
  }, 60_000);
});
