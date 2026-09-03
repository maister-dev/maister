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
  delegateRequest,
  type DelegationSeedCtx,
  resetDelegationFixture,
  seedAgent,
  seedChildRun,
  seedFlow,
  seedOrchestratorRun,
  seedTask,
} from "@/test-support/delegation-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-163 REQ-17: global concurrency accounting is preserved — a FLOW child
// draws MAISTER_MAX_CONCURRENT_RUNS and an AGENT child MAISTER_MAX_CONCURRENT_AGENTS.
// Two budgets, one tree. Only the per-orchestrator FAN-OUT cap is shared.
//
// The scheduler is deliberately NOT mocked here (unlike the flow-arm suite):
// the whole point is the real admission + promote path. Session spawn is stubbed
// at the supervisor seam and via promoteNextPending's injected `runFlow`.

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;
let ctx: DelegationSeedCtx;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
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
vi.mock("@/lib/flows/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/flows/runner")>();

  return { ...actual, runFlow: vi.fn(async () => undefined) };
});
vi.mock("@/lib/agents/session", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, startAgentSession: vi.fn(async () => undefined) };
});

let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
let delegatePost: typeof import("@/app/api/v1/ext/runs/delegate/route").POST;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-deleg-pool-"));
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_delegate_pools_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;
  // ADR-165: every launch places the run on the local execution host.
  await fakeExecutionHosts(db);

  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
  ({ POST: delegatePost } = await import(
    "@/app/api/v1/ext/runs/delegate/route"
  ));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

let parentRunId: string;
let secret: string;

beforeEach(async () => {
  ctx = await resetDelegationFixture({
    pool,
    db,
    agentsRoot,
    withGitRepo: true,
  });

  await seedFlow(ctx, { flowRefId: "delegated-flow" });

  const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
  const task = await seedTask(ctx);

  ({ runId: parentRunId, secret } = await seedOrchestratorRun(ctx, {
    orchestratorAgentId: orchestrator,
    taskId: task.id,
    issueToken: issueOrchestratorRunToken,
  }));
});

afterEach(() => {
  delete process.env.MAISTER_MAX_CONCURRENT_RUNS;
  delete process.env.MAISTER_MAX_CONCURRENT_AGENTS;
});

async function statusOf(runId: string): Promise<string> {
  return (
    await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [runId])
  ).rows[0].status;
}

describe("delegated children draw their own pool (ADR-163 REQ-17)", () => {
  it("a saturated FLOW pool parks the child Pending; freeing a slot promotes it", async () => {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "1";

    // One live FLOW run already holds the single flow slot. It is NOT a child of
    // this orchestrator, so the per-orchestrator fan-out cap is not what bites.
    const hogTask = await seedTask(ctx, { title: "hog" });
    const hogRunId = await seedChildRun(ctx, {
      parentRunId,
      runKind: "flow",
      status: "Running",
      taskId: hogTask.id,
    });

    await pool.query(
      `UPDATE "runs" SET "parent_run_id" = NULL, "root_run_id" = NULL WHERE "id" = $1`,
      [hogRunId],
    );

    const res = await delegatePost(
      delegateRequest(secret, {
        target: { flowId: "delegated-flow" },
        mode: "run",
        prompt: "queue behind the hog",
      }),
      {},
    );

    expect(res.status).toBe(202);
    const { childRunId } = (await res.json()) as { childRunId: string };

    // 202 with the child queued — a full pool is backpressure, not a refusal.
    expect(await statusOf(childRunId)).toBe("Pending");

    // Free the slot and drive the FLOW pool's queue.
    await pool.query(`UPDATE "runs" SET "status" = 'Done' WHERE "id" = $1`, [
      hogRunId,
    ]);

    const { promoteNextPending } = await import("@/lib/scheduler");
    const promoted = await promoteNextPending({
      db,
      pool: "flow",
      runFlow: () => undefined,
    });

    expect(promoted.promotedRunId).toBe(childRunId);
    expect(await statusOf(childRunId)).toBe("Running");
  }, 60_000);

  it("an AGENT sibling is admitted against the AGENT pool while the FLOW pool is full", async () => {
    process.env.MAISTER_MAX_CONCURRENT_RUNS = "1";
    process.env.MAISTER_MAX_CONCURRENT_AGENTS = "3";

    const hogTask = await seedTask(ctx, { title: "hog" });
    const hogRunId = await seedChildRun(ctx, {
      parentRunId,
      runKind: "flow",
      status: "Running",
      taskId: hogTask.id,
    });

    await pool.query(
      `UPDATE "runs" SET "parent_run_id" = NULL, "root_run_id" = NULL WHERE "id" = $1`,
      [hogRunId],
    );

    const worker = await seedAgent(ctx, { id: "worker" });
    const res = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "different budget",
      }),
      {},
    );

    expect(res.status).toBe(202);
    const { childRunId } = (await res.json()) as { childRunId: string };

    // The flow pool is full and the agent pool is not — the agent child starts.
    expect(await statusOf(childRunId)).toBe("Running");
  }, 60_000);
});
