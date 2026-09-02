import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

import {
  countRows,
  type DelegationSeedCtx,
  planRequest,
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

// ADR-163 REQ-01/REQ-09/REQ-11/REQ-12/REQ-15 for the `run_plan` entry point.

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;
let ctx: DelegationSeedCtx;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
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

let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
let planPost: typeof import("@/app/api/v1/ext/runs/plan/route").POST;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-plan-flow-"));
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_plan_flow_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
  ({ POST: planPost } = await import("@/app/api/v1/ext/runs/plan/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

let parentRunId: string;
let secret: string;
let flowId: string;
let workerAgentId: string;

beforeEach(async () => {
  ctx = await resetDelegationFixture({
    pool,
    db,
    agentsRoot,
    withGitRepo: true,
  });

  ({ flowId } = await seedFlow(ctx, { flowRefId: "delegated-flow" }));

  const orchestrator = await seedAgent(ctx, { id: "orchestrator" });

  workerAgentId = await seedAgent(ctx, { id: "worker" });

  const task = await seedTask(ctx);

  ({ runId: parentRunId, secret } = await seedOrchestratorRun(ctx, {
    orchestratorAgentId: orchestrator,
    taskId: task.id,
    issueToken: issueOrchestratorRunToken,
  }));
});

afterEach(() => {
  delete process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;
});

describe("run_plan flow targets (ADR-163)", () => {
  it("a MIXED agent+flow DAG writes every task, spec, and requires edge in one transaction", async () => {
    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "spec",
            target: { agentId: workerAgentId },
            prompt: "write the spec",
            dependsOn: [],
          },
          {
            key: "impl",
            target: { flowId: "delegated-flow" },
            prompt: "implement it",
            title: "Implement",
            dependsOn: ["spec"],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as {
      tasks: { key: string; taskId: string; childRunId?: string }[];
    };

    expect(json.tasks.map((t) => t.key).sort()).toEqual(["impl", "spec"]);

    const byKey = new Map(json.tasks.map((t) => [t.key, t]));
    const implTask = (
      await pool.query(
        `SELECT "flow_id", "launch_mode", "delegation_spec" FROM "tasks" WHERE "id" = $1`,
        [byKey.get("impl")!.taskId],
      )
    ).rows[0];

    // REQ-11: a flow entry's task carries the SELECTED flow.
    expect(implTask.flow_id).toBe(flowId);
    expect(implTask.launch_mode).toBe("auto");
    expect(implTask.delegation_spec).toEqual({ kind: "flow", flowId });

    const specTask = (
      await pool.query(
        `SELECT "flow_id", "delegation_spec" FROM "tasks" WHERE "id" = $1`,
        [byKey.get("spec")!.taskId],
      )
    ).rows[0];

    // An agent entry's task stays flowless (a simple-intent task) — unchanged.
    expect(specTask.flow_id).toBeNull();
    expect(specTask.delegation_spec).toEqual({
      kind: "agent",
      agentId: workerAgentId,
    });

    const requires = (
      await pool.query(
        `SELECT "from_task_id", "to_task_id" FROM "task_relations" WHERE "kind" = 'requires'`,
      )
    ).rows;

    expect(requires).toHaveLength(1);
    expect(requires[0].from_task_id).toBe(byKey.get("impl")!.taskId);
    expect(requires[0].to_task_id).toBe(byKey.get("spec")!.taskId);

    // Only the SOURCE (no dependsOn) launches immediately.
    expect(byKey.get("spec")!.childRunId).toBeTruthy();
    expect(byKey.get("impl")!.childRunId).toBeUndefined();
  }, 60_000);

  it("a FLOW source entry launches through the flow pipeline with its snapshot", async () => {
    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "only",
            target: { flowId: "delegated-flow" },
            prompt: "governed work",
            dependsOn: [],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(202);
    const { tasks } = (await res.json()) as {
      tasks: { key: string; taskId: string; childRunId?: string }[];
    };

    expect(tasks[0].childRunId).toBeTruthy();

    const child = (
      await pool.query(
        `SELECT "run_kind", "task_id", "flow_id", "flow_revision_id", "launch_mode", "delegation_snapshot"
           FROM "runs" WHERE "id" = $1`,
        [tasks[0].childRunId],
      )
    ).rows[0];

    expect(child.run_kind).toBe("flow");
    expect(child.task_id).toBe(tasks[0].taskId);
    expect(child.flow_id).toBe(flowId);
    expect(child.launch_mode).toBe("auto");
    expect(child.delegation_snapshot).toMatchObject({
      kind: "flow",
      flowId,
      flowRefId: "delegated-flow",
      // Codex review F4: the launcher's own pin, never the route's resolve.
      flowRevisionId: child.flow_revision_id,
      carrierTaskId: tasks[0].taskId,
      baseBranch: "main",
      targetBranch: "main",
    });
  }, 60_000);

  it("one bad flow entry writes NOTHING and reports every failure at once", async () => {
    await seedFlow(ctx, {
      flowRefId: "untrusted-flow",
      trustStatus: "untrusted",
    });

    const tasksBefore = await countRows(ctx, "tasks");

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "a",
            target: { flowId: "untrusted-flow" },
            prompt: "p",
            dependsOn: [],
          },
          {
            key: "b",
            target: { flowId: "no-such-flow" },
            prompt: "p",
            dependsOn: [],
          },
          {
            key: "c",
            target: { agentId: workerAgentId },
            prompt: "p",
            dependsOn: [],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; message: string };

    expect(json.code).toBe("PRECONDITION");
    // BOTH bad entries, not just the first — an all-or-nothing validation that
    // reported one failure per round-trip would make a 10-entry DAG a 10-step
    // guessing game. Each line names the entry and carries its own code.
    expect(json.message).toContain("a (untrusted-flow): [PRECONDITION]");
    expect(json.message).toContain("b (no-such-flow): [PRECONDITION]");
    expect(await countRows(ctx, "tasks")).toBe(tasksBefore);
    expect(await countRows(ctx, "task_relations")).toBe(0);
  }, 60_000);

  // ADR-163 review Q2-A: a per-kind allow-list violation is a SHAPE problem and
  // answers CONFIG 422 before any resolution work — the same code and status
  // `run_delegate` gives the same field on the same target kind.
  it("`workspace` on a flow entry is refused CONFIG 422 before resolution, not silently dropped", async () => {
    const tasksBefore = await countRows(ctx, "tasks");

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "a",
            target: { flowId: "delegated-flow" },
            prompt: "p",
            workspace: "worktree",
            dependsOn: [],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(422);
    const json = (await res.json()) as { code: string; message: string };

    expect(json.code).toBe("CONFIG");
    expect(json.message).toContain(
      "a (delegated-flow): workspace is not supported for flow targets",
    );
    expect(await countRows(ctx, "tasks")).toBe(tasksBefore);
  }, 60_000);

  // ADR-163 review Q2-A: resolution failures keep their own code when the batch
  // agrees on one (here CONFIG for two engine-incompatible flows, as
  // `run_delegate` would answer for either alone)...
  it("a batch whose resolution failures are all CONFIG answers CONFIG 422", async () => {
    await seedFlow(ctx, { flowRefId: "future-a", engineMin: "99.0.0" });
    await seedFlow(ctx, { flowRefId: "future-b", engineMin: "99.0.0" });

    const tasksBefore = await countRows(ctx, "tasks");

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "a",
            target: { flowId: "future-a" },
            prompt: "p",
            dependsOn: [],
          },
          {
            key: "b",
            target: { flowId: "future-b" },
            prompt: "p",
            dependsOn: [],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(422);
    const json = (await res.json()) as { code: string; message: string };

    expect(json.code).toBe("CONFIG");
    expect(json.message).toContain("a (future-a): [CONFIG]");
    expect(json.message).toContain("b (future-b): [CONFIG]");
    expect(await countRows(ctx, "tasks")).toBe(tasksBefore);
  }, 60_000);

  // ...and a MIXED batch aggregates to the conservative PRECONDITION 409 with
  // every entry still tagged by its own code, so nothing is hidden.
  it("a batch mixing PRECONDITION and CONFIG failures answers PRECONDITION 409 with per-entry codes", async () => {
    await seedFlow(ctx, {
      flowRefId: "untrusted-flow",
      trustStatus: "untrusted",
    });
    await seedFlow(ctx, { flowRefId: "future-a", engineMin: "99.0.0" });

    const tasksBefore = await countRows(ctx, "tasks");

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "a",
            target: { flowId: "untrusted-flow" },
            prompt: "p",
            dependsOn: [],
          },
          {
            key: "b",
            target: { flowId: "future-a" },
            prompt: "p",
            dependsOn: [],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; message: string };

    expect(json.code).toBe("PRECONDITION");
    expect(json.message).toContain("a (untrusted-flow): [PRECONDITION]");
    expect(json.message).toContain("b (future-a): [CONFIG]");
    expect(await countRows(ctx, "tasks")).toBe(tasksBefore);
  }, 60_000);

  // REQ-15: the batch bound is `live children + batch size`, not the batch
  // length alone — the pre-ADR-163 check could not see already-running children.
  it("the batch is bounded by LIVE children plus its own size", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "3";

    await seedChildRun(ctx, {
      parentRunId,
      runKind: "flow",
      status: "Running",
      flowId,
    });
    await seedChildRun(ctx, {
      parentRunId,
      runKind: "agent",
      status: "Review",
    });

    const tasksBefore = await countRows(ctx, "tasks");
    const body = (keys: string[]) => ({
      tasks: keys.map((key) => ({
        key,
        target: { agentId: workerAgentId },
        prompt: "p",
        dependsOn: [],
      })),
    });

    // 2 live + 2 incoming = 4 > 3 → refused, nothing written. The old
    // batch-length check (2 <= 3) would have admitted this.
    const tooBig = await planPost(planRequest(secret, body(["a", "b"])), {});

    expect(tooBig.status).toBe(422);
    expect(((await tooBig.json()) as { code: string }).code).toBe("CONFIG");
    expect(await countRows(ctx, "tasks")).toBe(tasksBefore);

    // 2 live + 1 incoming = 3 fits exactly.
    const fits = await planPost(planRequest(secret, body(["a"])), {});

    expect(fits.status).toBe(202);
  }, 60_000);
});
