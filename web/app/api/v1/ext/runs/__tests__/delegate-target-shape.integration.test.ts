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

import {
  countRows,
  delegateRequest,
  type DelegationSeedCtx,
  planRequest,
  resetDelegationFixture,
  seedAgent,
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
let delegatePost: typeof import("@/app/api/v1/ext/runs/delegate/route").POST;
let planPost: typeof import("@/app/api/v1/ext/runs/plan/route").POST;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-deleg-shape-"));
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_delegate_shape_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
  ({ POST: delegatePost } = await import(
    "@/app/api/v1/ext/runs/delegate/route"
  ));
  ({ POST: planPost } = await import("@/app/api/v1/ext/runs/plan/route"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  ctx = await resetDelegationFixture({ pool, db, agentsRoot });
});

// ADR-163 REQ-01: `target` is a DISCRIMINATED UNION — exactly one of
// agentId / flowId, enforced by schema rather than by optional fields plus a
// procedural fallback. Both present and neither present are BOTH refusals, both
// write nothing, and both must SAY which contract was violated.
//
// Asserting the status + code alone would be a trivially-green test: today's
// route already answers 422 CONFIG to both shapes — "both present" because it
// short-circuits on `if (body.target.flowId)` into "flow-target delegation is
// not yet supported" (an actively MISLEADING message for a both-present body),
// and "neither" because of a separate `target.agentId is required` branch.
// Pinning the union's own message is what distinguishes the contract from the
// coincidence. The MCP/OpenAPI half is locked by
// mcp/src/__tests__/tool-contract.test.ts (the oneOf arm-set signature); this
// file locks the ROUTE half for both delegation entry points.
const UNION_MESSAGE = "exactly one of agentId / flowId";

describe("delegation target shape (ADR-163 REQ-01)", () => {
  const CASES: {
    name: string;
    target: Record<string, unknown>;
    detail: string;
  }[] = [
    {
      name: "both agentId and flowId present",
      target: { agentId: "test-pkg:worker", flowId: "some-flow" },
      detail: "both present",
    },
    {
      name: "neither agentId nor flowId present",
      target: {},
      detail: "neither present",
    },
  ];

  describe.each(CASES)("run_delegate — $name", ({ target, detail }) => {
    it("→ CONFIG 422 naming the union violation, and writes no rows", async () => {
      const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
      const task = await seedTask(ctx);
      const { secret } = await seedOrchestratorRun(ctx, {
        orchestratorAgentId: orchestrator,
        taskId: task.id,
        issueToken: issueOrchestratorRunToken,
      });

      const runsBefore = await countRows(ctx, "runs");
      const tasksBefore = await countRows(ctx, "tasks");

      const res = await delegatePost(
        delegateRequest(secret, {
          target,
          mode: "run",
          prompt: "ambiguous target",
        }),
        {},
      );

      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; message: string };

      expect(body.code).toBe("CONFIG");
      expect(body.message).toContain(UNION_MESSAGE);
      expect(body.message).toContain(detail);
      expect(await countRows(ctx, "runs")).toBe(runsBefore);
      expect(await countRows(ctx, "tasks")).toBe(tasksBefore);
    });
  });

  describe.each(CASES)("run_plan — $name", ({ target, detail }) => {
    it("→ CONFIG 422 naming the union violation, and writes no rows", async () => {
      const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
      const task = await seedTask(ctx);
      const { secret } = await seedOrchestratorRun(ctx, {
        orchestratorAgentId: orchestrator,
        taskId: task.id,
        issueToken: issueOrchestratorRunToken,
      });

      const runsBefore = await countRows(ctx, "runs");
      const tasksBefore = await countRows(ctx, "tasks");

      const res = await planPost(
        planRequest(secret, {
          tasks: [
            { key: "a", target, prompt: "ambiguous target", dependsOn: [] },
          ],
        }),
        {},
      );

      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; message: string };

      expect(body.code).toBe("CONFIG");
      expect(body.message).toContain(UNION_MESSAGE);
      expect(body.message).toContain(detail);
      expect(await countRows(ctx, "runs")).toBe(runsBefore);
      expect(await countRows(ctx, "tasks")).toBe(tasksBefore);
    });
  });
});
