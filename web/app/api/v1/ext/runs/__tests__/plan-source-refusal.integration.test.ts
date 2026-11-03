import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

import { bindQueuedDelegationResponse } from "@/test-support/queued-delegation";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  type DelegationSeedCtx,
  planRequest,
  resetDelegationFixture,
  seedAgent,
  seedFlow,
  seedOrchestratorRun,
  seedTask,
} from "@/test-support/delegation-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// Codex review F3 (ADR-163): the post-commit SOURCE launch of `run_plan` used
// to swallow every refusal into a 202 whose result row was indistinguishable
// from a legitimately blocked dependent. Nothing retried a sole failed source
// (the auto-launcher fires only on a sibling settle, the C2 queue excludes
// as-plan tasks), and the orchestrator — counting zero child RUNS — completed
// its node over a dead DAG. The contract now: a partial refusal is reported on
// its row (`launchError`) + a system comment and self-heals on the next sibling
// settle; when EVERY source is refused nothing runs, the committed DAG is
// abandoned (parity with `run_delegate`'s compensation) and the refusal's code
// is the answer.

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;
let ctx: DelegationSeedCtx;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
let planPost: typeof import("@/app/api/v1/ext/runs/plan/route").POST;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-plan-refusal-"));
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_plan_source_refusal_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  await fakeExecutionHosts(db);

  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
  const planPostEndpoint = (await import("@/app/api/v1/ext/runs/plan/route"))
    .POST;

  planPost = async (request, context) =>
    bindQueuedDelegationResponse(
      db as unknown as import("@/lib/execution-host/db").Db,
      await planPostEndpoint(request, context),
    );
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

let worker: string;
let secret: string;

beforeEach(async () => {
  ctx = await resetDelegationFixture({
    pool,
    db,
    agentsRoot,
    withGitRepo: true,
  });

  const orchestrator = await seedAgent(ctx, { id: "orchestrator" });

  worker = await seedAgent(ctx, { id: "worker" });

  const orchestratorTask = await seedTask(ctx, { title: "orchestrator" });

  ({ secret } = await seedOrchestratorRun(ctx, {
    orchestratorAgentId: orchestrator,
    taskId: orchestratorTask.id,
    issueToken: issueOrchestratorRunToken,
  }));
});

async function taskStatuses(): Promise<Map<string, string>> {
  const rows = await pool.query(
    `SELECT "id", "status" FROM "tasks" WHERE "launch_mode" = 'auto'`,
  );

  return new Map(rows.rows.map((row) => [row.id, row.status]));
}

async function systemComments(taskId: string): Promise<string[]> {
  const rows = await pool.query(
    `SELECT "body" FROM "task_comments" WHERE "task_id" = $1 AND "actor_type" = 'system' ORDER BY "created_at"`,
    [taskId],
  );

  return rows.rows.map((row) => row.body);
}

type ResultItem = {
  key: string;
  taskId: string;
  childRunId?: string;
  launchError?: { code: string; message: string };
};

describe("POST /api/v1/ext/runs/plan — source-launch refusals", () => {
  it("every source refused by real runner admission → the whole committed DAG Abandoned, nothing runs", async () => {
    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "A",
            target: { agentId: worker },
            runnerOverride: "unavailable-runner",
            prompt: "a",
            dependsOn: [],
          },
          {
            key: "B",
            target: { agentId: worker },
            prompt: "b",
            dependsOn: ["A"],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(409);

    const json = (await res.json()) as { code: string; message: string };

    expect(json.code).toBe("PRECONDITION");
    expect(json.message).toContain("A: [PRECONDITION]");

    const statuses = await taskStatuses();

    expect(statuses.size).toBe(2);
    expect([...statuses.values()]).toEqual(["Abandoned", "Abandoned"]);

    const relations = await pool.query(
      `SELECT count(*)::int AS n FROM "task_relations" WHERE "kind" = 'parent_of'`,
    );

    expect(relations.rows[0].n).toBe(2);
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM "runs"`)).rows[0].n,
    ).toBe(1);
  }, 60_000);

  it("a PARTIAL refusal keeps the DAG: 202, the refused source reports launchError + a system comment, the other source launched", async () => {
    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "A",
            target: { agentId: worker },
            runnerOverride: "unavailable-runner",
            prompt: "a",
            dependsOn: [],
          },
          { key: "B", target: { agentId: worker }, prompt: "b", dependsOn: [] },
          {
            key: "C",
            target: { agentId: worker },
            prompt: "c",
            dependsOn: ["A"],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(202);

    const json = (await res.json()) as { tasks: ResultItem[] };
    const byKey = new Map(json.tasks.map((t) => [t.key, t]));

    expect(byKey.get("A")).toMatchObject({
      launchError: {
        code: "PRECONDITION",
        reason: "launch_runner_unavailable",
        message: expect.stringContaining("choose a ready runner"),
      },
    });
    expect(byKey.get("A")!.childRunId).toBeUndefined();
    expect(byKey.get("B")!.childRunId).toBeTruthy();
    expect(byKey.get("B")!.launchError).toBeUndefined();
    expect(byKey.get("C")!.childRunId).toBeUndefined();
    expect(byKey.get("C")!.launchError).toBeUndefined();

    const statuses = await taskStatuses();

    expect(statuses.get(byKey.get("A")!.taskId)).toBe("Backlog");
    expect(statuses.get(byKey.get("C")!.taskId)).toBe("Backlog");

    const comments = await systemComments(byKey.get("A")!.taskId);

    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("PRECONDITION");
    expect(comments[0]).toContain("choose a ready runner");
    expect(await systemComments(byKey.get("B")!.taskId)).toHaveLength(0);
    expect(await systemComments(byKey.get("C")!.taskId)).toHaveLength(0);
  }, 60_000);

  it("every source refused with MIXED codes → PRECONDITION 409, each line tagged with its own code", async () => {
    const { flowId: invalidRunnerFlow } = await seedFlow(ctx, {
      flowRefId: "mixed-flow",
    });

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "A",
            target: { agentId: worker },
            runnerOverride: "unavailable-runner",
            prompt: "a",
            dependsOn: [],
          },
          {
            key: "B",
            target: { flowId: invalidRunnerFlow },
            runnerOverride: "unavailable-flow-runner",
            prompt: "b",
            dependsOn: [],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(409);

    const json = (await res.json()) as { code: string; message: string };

    expect(json.code).toBe("PRECONDITION");
    expect(json.message).toContain("A: [PRECONDITION]");
    expect(json.message).toContain("B: [EXECUTOR_UNAVAILABLE]");
    expect([...(await taskStatuses()).values()]).toEqual([
      "Abandoned",
      "Abandoned",
    ]);
  }, 60_000);
});
