import { randomUUID } from "node:crypto";
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

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-deleg-refuse-"));
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_delegate_refusals_test",
  });
  pool = testDatabase.pool;
  db = testDatabase.db;

  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
  ({ POST: delegatePost } = await import(
    "@/app/api/v1/ext/runs/delegate/route"
  ));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(async () => {
  ctx = await resetDelegationFixture({ pool, db, agentsRoot });
});

// ADR-163 REQ-04/05/12/16: the refusal table from
// docs/system-analytics/orchestrator.md, transcribed one row per case.
//
// Deliberately NOT re-covered here (minimum overlap — each behaviour has one
// owning test): the both/neither target shape rows live in
// delegate-target-shape.integration.test.ts; no-run-bound-token, terminal
// orchestrator, and over-depth live in delegate-agent-compat.integration.test.ts;
// the shared fan-out cap lives in lib/orchestrator/__tests__/admission.
//
// Every row asserts the same three things: the typed code, the HTTP status, and
// that NOTHING was written — `runs` AND `tasks` both unchanged. The zero-rows
// half is the point: trust resolution is physically separate from launch, so a
// refusal above the carrier-task line can never leave a carrier task behind.
type RefusalCase = {
  name: string;
  code: "CONFIG" | "PRECONDITION";
  status: number;
  /**
   * A discriminating fragment of the refusal message. Asserting code + status
   * alone would leave half these rows trivially green: today the route answers
   * `CONFIG` 422 to EVERY flow target with "flow-target delegation is not yet
   * supported", so a field-allow-list row and an engine-incompatibility row are
   * indistinguishable from each other and from the stub. The message is what
   * tells the caller which contract it violated, so it is part of the contract.
   */
  messageContains: string;
  /** Arrange the fixture and return the delegation body to POST. */
  arrange: () => Promise<Record<string, unknown>>;
};

async function orchestratorToken(): Promise<string> {
  const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
  const task = await seedTask(ctx);
  const { secret } = await seedOrchestratorRun(ctx, {
    orchestratorAgentId: orchestrator,
    taskId: task.id,
    issueToken: issueOrchestratorRunToken,
  });

  return secret;
}

async function flowBody(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    target: { flowId: "delegated-flow" },
    mode: "run",
    prompt: "do the governed thing",
    ...overrides,
  };
}

const CASES: RefusalCase[] = [
  // ---- per-kind field allow-list (REQ-12) --------------------------------
  {
    name: "workspace on a flow target",
    code: "CONFIG",
    status: 422,
    messageContains: "workspace is not supported for flow targets",
    arrange: async () => {
      await seedFlow(ctx, { flowRefId: "delegated-flow" });

      return flowBody({ workspace: "worktree" });
    },
  },
  {
    name: "workspaceMode on a flow target",
    code: "CONFIG",
    status: 422,
    messageContains: "workspaceMode is agent-target only",
    arrange: async () => {
      await seedFlow(ctx, { flowRefId: "delegated-flow" });

      return flowBody({ workspaceMode: "shared" });
    },
  },
  {
    name: "persistent on a flow target",
    code: "CONFIG",
    status: 422,
    messageContains: "persistent children are agent-target only",
    arrange: async () => {
      await seedFlow(ctx, { flowRefId: "delegated-flow" });

      return flowBody({ persistent: true, addressableKey: "k" });
    },
  },
  {
    name: "addressableKey on a flow target",
    code: "CONFIG",
    status: 422,
    messageContains: "addressableKey is agent-target only",
    arrange: async () => {
      await seedFlow(ctx, { flowRefId: "delegated-flow" });

      return flowBody({ addressableKey: "k" });
    },
  },
  {
    name: "title on an AGENT mode:run target (an agent run child has no task to name)",
    code: "CONFIG",
    status: 422,
    messageContains: "title is only meaningful with mode:task",
    arrange: async () => {
      const worker = await seedAgent(ctx, { id: "worker" });

      return {
        target: { agentId: worker },
        mode: "run",
        prompt: "no task to name",
        title: "Nameless",
      };
    },
  },

  // ---- flow trust resolution (REQ-03/04/16) ------------------------------
  {
    name: "an unknown flow ref",
    code: "PRECONDITION",
    status: 409,
    messageContains: "invalid flowId",
    arrange: async () => flowBody({ target: { flowId: "no-such-flow" } }),
  },
  {
    name: "a flow that belongs to ANOTHER project",
    code: "PRECONDITION",
    status: 409,
    messageContains: "invalid flowId",
    arrange: async () => {
      const otherProjectId = randomUUID();

      await pool.query(
        `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
         VALUES ($1, $2, 'Other', $3, 'main', 'maister/', '/tmp/other.yaml', 'OTHER', 1)`,
        [
          otherProjectId,
          `other-${otherProjectId.slice(0, 8)}`,
          `/repos/other-${otherProjectId}`,
        ],
      );
      await seedFlow(
        { ...ctx, projectId: otherProjectId },
        { flowRefId: "delegated-flow" },
      );

      return flowBody();
    },
  },
  {
    name: "a flow whose enablement state is not launchable",
    code: "PRECONDITION",
    status: 409,
    messageContains: "not launchable",
    arrange: async () => {
      await seedFlow(ctx, {
        flowRefId: "delegated-flow",
        enablementState: "Installed",
      });

      return flowBody();
    },
  },
  {
    name: "an untrusted flow package",
    code: "PRECONDITION",
    status: 409,
    messageContains: "not trusted",
    arrange: async () => {
      await seedFlow(ctx, {
        flowRefId: "delegated-flow",
        trustStatus: "untrusted",
      });

      return flowBody();
    },
  },
  {
    name: "a flow with no enabled revision pointer",
    code: "PRECONDITION",
    status: 409,
    messageContains: "has no enabled package revision",
    arrange: async () => {
      await seedFlow(ctx, {
        flowRefId: "delegated-flow",
        withoutEnabledRevision: true,
      });

      return flowBody();
    },
  },
  // NOTE: the refusal table's "no enabled_revision_id / revision row missing"
  // row is ONE case, not two. `flows.enabled_revision_id` is a FK with
  // ON DELETE SET NULL, so "the revision row vanished" degrades into the NULL
  // pointer case above and the dangling-pointer state is unreachable through
  // the schema. The resolver still keeps a `!revision` guard as defence in
  // depth (mirroring launchRunStaged), but an unreachable state is not a
  // testable contract row and is deliberately not asserted here.
  {
    name: "a revision that is not Installed",
    code: "PRECONDITION",
    status: 409,
    messageContains: "not Installed",
    arrange: async () => {
      await seedFlow(ctx, {
        flowRefId: "delegated-flow",
        packageStatus: "Failed",
      });

      return flowBody();
    },
  },
  {
    name: "a revision whose setup is still pending",
    code: "PRECONDITION",
    status: 409,
    messageContains: "package setup is pending",
    arrange: async () => {
      await seedFlow(ctx, {
        flowRefId: "delegated-flow",
        setupStatus: "pending",
      });

      return flowBody();
    },
  },
  {
    name: "a revision whose setup FAILED",
    code: "PRECONDITION",
    status: 409,
    messageContains: "package setup is failed",
    arrange: async () => {
      await seedFlow(ctx, {
        flowRefId: "delegated-flow",
        setupStatus: "failed",
      });

      return flowBody();
    },
  },
  {
    name: "an unsupported manifest schemaVersion",
    code: "CONFIG",
    status: 422,
    messageContains: "unsupported manifest schemaVersion",
    arrange: async () => {
      await seedFlow(ctx, { flowRefId: "delegated-flow", schemaVersion: 99 });

      return flowBody();
    },
  },
  {
    name: "an engine range this MAIster engine cannot satisfy",
    code: "CONFIG",
    status: 422,
    messageContains: "incompatible with this MAIster engine",
    arrange: async () => {
      await seedFlow(ctx, {
        flowRefId: "delegated-flow",
        engineMin: "99.0.0",
      });

      return flowBody();
    },
  },
];

describe("run_delegate refusal table (ADR-163)", () => {
  describe.each(CASES)("refuses $name", (testCase) => {
    it("→ typed refusal at the documented status, and ZERO rows written", async () => {
      const secret = await orchestratorToken();
      const body = await testCase.arrange();

      const runsBefore = await countRows(ctx, "runs");
      const tasksBefore = await countRows(ctx, "tasks");
      const relationsBefore = await countRows(ctx, "task_relations");

      const res = await delegatePost(delegateRequest(secret, body), {});

      expect(res.status).toBe(testCase.status);
      const json = (await res.json()) as { code: string; message: string };

      expect(json.code).toBe(testCase.code);
      expect(json.message).toContain(testCase.messageContains);
      expect(await countRows(ctx, "runs")).toBe(runsBefore);
      expect(await countRows(ctx, "tasks")).toBe(tasksBefore);
      expect(await countRows(ctx, "task_relations")).toBe(relationsBefore);
    });
  });
});
