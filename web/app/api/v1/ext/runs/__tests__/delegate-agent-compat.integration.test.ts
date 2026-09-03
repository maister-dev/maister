import { randomUUID } from "node:crypto";
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
  delegateRequest,
  type DelegationSeedCtx,
  resetDelegationFixture,
  seedAgent,
  seedOrchestratorRun,
  seedTask,
  seedUntrustedPackageAgent,
} from "@/test-support/delegation-seed";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
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
    deleteSession: vi.fn(async () => undefined),
  };
});

let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
let delegatePost: typeof import("@/app/api/v1/ext/runs/delegate/route").POST;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-deleg-compat-"));
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_delegate_compat_test",
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

beforeEach(async () => {
  ctx = await resetDelegationFixture({ pool, db, agentsRoot });
});

afterEach(() => {
  delete process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH;
});

// ADR-163 REQ-02: the AGENT arm of `run_delegate` must keep working
// byte-for-byte through the discriminated-union rewrite. This is the regression
// fence, so it is GREEN from the start by design — a red here is a
// compatibility break, never progress.
//
// Written as two tables rather than N copy-pasted bodies: the success cases
// assert genuinely different row shapes, the refusal cases share one assertion
// ("typed refusal, no child run") and differ only in how the fixture is armed.
describe("run_delegate — agent-target compatibility replay (ADR-163 REQ-02)", () => {
  describe("success arms", () => {
    it("as-task → child task + parent_of relation + child run with delegation_snapshot", async () => {
      const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
      const worker = await seedAgent(ctx, { id: "worker" });
      const task = await seedTask(ctx);
      const { runId: parentRunId, secret } = await seedOrchestratorRun(ctx, {
        orchestratorAgentId: orchestrator,
        taskId: task.id,
        issueToken: issueOrchestratorRunToken,
      });

      const res = await delegatePost(
        delegateRequest(secret, {
          target: { agentId: worker },
          mode: "task",
          prompt: "Investigate the failing test",
          title: "Investigate",
        }),
        {},
      );

      expect(res.status).toBe(202);
      const json = (await res.json()) as {
        childRunId: string;
        childTaskId?: string;
      };

      expect(json.childRunId).toBeTruthy();
      expect(json.childTaskId).toBeTruthy();

      const childTask = await pool.query(
        `SELECT "title" FROM "tasks" WHERE "id" = $1`,
        [json.childTaskId],
      );

      expect(childTask.rows).toHaveLength(1);
      expect(childTask.rows[0].title).toBe("Investigate");

      const rel = await pool.query(
        `SELECT "kind", "to_task_id" FROM "task_relations" WHERE "from_task_id" = $1`,
        [task.id],
      );

      expect(rel.rows).toHaveLength(1);
      expect(rel.rows[0].kind).toBe("parent_of");
      expect(rel.rows[0].to_task_id).toBe(json.childTaskId);

      const childRun = (
        await pool.query(
          `SELECT "parent_run_id", "task_id", "delegation_snapshot", "launch_mode", "run_kind"
           FROM "runs" WHERE "id" = $1`,
          [json.childRunId],
        )
      ).rows[0];

      expect(childRun.parent_run_id).toBe(parentRunId);
      expect(childRun.task_id).toBe(json.childTaskId);
      expect(childRun.run_kind).toBe("agent");
      expect(childRun.delegation_snapshot.agentDefinitionId).toBe(worker);
      expect(childRun.delegation_snapshot.revisionId).toBeTruthy();
      expect(childRun.launch_mode).toBe("manual");
    });

    it("as-run → child run with parent_run_id and NO task (no board card)", async () => {
      const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
      const worker = await seedAgent(ctx, { id: "worker" });
      const { runId: parentRunId, secret } = await seedOrchestratorRun(ctx, {
        orchestratorAgentId: orchestrator,
        taskId: null,
        issueToken: issueOrchestratorRunToken,
      });

      const tasksBefore = await countRows(ctx, "tasks");

      const res = await delegatePost(
        delegateRequest(secret, {
          target: { agentId: worker },
          mode: "run",
          prompt: "No board card please",
        }),
        {},
      );

      expect(res.status).toBe(202);
      const json = (await res.json()) as {
        childRunId: string;
        childTaskId?: string;
      };

      expect(json.childTaskId).toBeUndefined();
      expect(await countRows(ctx, "tasks")).toBe(tasksBefore);

      const childRun = (
        await pool.query(
          `SELECT "parent_run_id", "task_id" FROM "runs" WHERE "id" = $1`,
          [json.childRunId],
        )
      ).rows[0];

      expect(childRun.parent_run_id).toBe(parentRunId);
      expect(childRun.task_id).toBeNull();
    });

    it("root_run_id propagates from the parent's tree root, and the runner is snapshotted", async () => {
      const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
      const worker = await seedAgent(ctx, { id: "worker" });
      const rootRunId = randomUUID();

      await pool.query(
        `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "status", "flow_version", "flow_revision")
         VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual')`,
        [rootRunId, orchestrator, ctx.projectId],
      );

      const { secret } = await seedOrchestratorRun(ctx, {
        orchestratorAgentId: orchestrator,
        taskId: null,
        parentRunId: rootRunId,
        rootRunId,
        issueToken: issueOrchestratorRunToken,
      });

      const res = await delegatePost(
        delegateRequest(secret, {
          target: { agentId: worker },
          mode: "run",
          prompt: "grandchild",
        }),
        {},
      );

      expect(res.status).toBe(202);
      const { childRunId } = (await res.json()) as { childRunId: string };

      const childRun = (
        await pool.query(`SELECT "root_run_id" FROM "runs" WHERE "id" = $1`, [
          childRunId,
        ])
      ).rows[0];

      expect(childRun.root_run_id).toBe(rootRunId);

      const session = (
        await pool.query(
          `SELECT "runner_snapshot" FROM "run_sessions" WHERE "run_id" = $1`,
          [childRunId],
        )
      ).rows[0];

      expect(session.runner_snapshot).toBeTruthy();
    });
  });

  // One assertion, one row per way the fixture can be armed. Each arrange
  // returns the token + body; the shared body proves the SAME contract —
  // a typed refusal at the documented status, and NO child run created.
  type RefusalCase = {
    name: string;
    code: "CONFIG" | "PRECONDITION";
    status: number;
    arrange: () => Promise<{ secret: string | null; body: unknown }>;
  };

  const REFUSAL_CASES: RefusalCase[] = [
    {
      name: "the target agent's catalog kill switch is off",
      code: "PRECONDITION",
      status: 409,
      arrange: async () => {
        const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
        const worker = await seedAgent(ctx, { id: "worker", enabled: false });
        const { secret } = await seedOrchestratorRun(ctx, {
          orchestratorAgentId: orchestrator,
          taskId: null,
          issueToken: issueOrchestratorRunToken,
        });

        return {
          secret,
          body: {
            target: { agentId: worker },
            mode: "run",
            prompt: "disabled agent",
          },
        };
      },
    },
    {
      name: "the target agent's PACKAGE is untrusted",
      code: "PRECONDITION",
      status: 409,
      arrange: async () => {
        const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
        const worker = await seedUntrustedPackageAgent(ctx, {
          id: "worker",
          trustStatus: "untrusted",
        });
        const { secret } = await seedOrchestratorRun(ctx, {
          orchestratorAgentId: orchestrator,
          taskId: null,
          issueToken: issueOrchestratorRunToken,
        });

        return {
          secret,
          body: {
            target: { agentId: worker },
            mode: "run",
            prompt: "untrusted package",
          },
        };
      },
    },
    {
      name: "the target agent's PACKAGE is Disabled (unattached)",
      code: "PRECONDITION",
      status: 409,
      arrange: async () => {
        const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
        const worker = await seedUntrustedPackageAgent(ctx, {
          id: "worker",
          trustStatus: "trusted",
          enablementState: "Disabled",
        });
        const { secret } = await seedOrchestratorRun(ctx, {
          orchestratorAgentId: orchestrator,
          taskId: null,
          issueToken: issueOrchestratorRunToken,
        });

        return {
          secret,
          body: {
            target: { agentId: worker },
            mode: "run",
            prompt: "disabled package",
          },
        };
      },
    },
    {
      name: "the bound orchestrator has TERMINALIZED",
      code: "PRECONDITION",
      status: 409,
      arrange: async () => {
        const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
        const worker = await seedAgent(ctx, { id: "worker" });
        const { runId, secret } = await seedOrchestratorRun(ctx, {
          orchestratorAgentId: orchestrator,
          taskId: null,
          issueToken: issueOrchestratorRunToken,
        });

        await pool.query(
          `UPDATE "runs" SET "status" = 'Done' WHERE "id" = $1`,
          [runId],
        );

        return {
          secret,
          body: {
            target: { agentId: worker },
            mode: "run",
            prompt: "terminal tree",
          },
        };
      },
    },
    {
      name: "the parent chain is already at MAISTER_ORCHESTRATOR_MAX_DEPTH",
      code: "CONFIG",
      status: 422,
      arrange: async () => {
        process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH = "2";

        const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
        const worker = await seedAgent(ctx, { id: "worker" });
        const r0 = randomUUID();
        const r1 = randomUUID();

        for (const [id, parent] of [
          [r0, null],
          [r1, r0],
        ] as [string, string | null][]) {
          await pool.query(
            `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id")
             VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $4, $5)`,
            [id, orchestrator, ctx.projectId, parent, parent],
          );
          await pool.query(
            `INSERT INTO "run_sessions" ("id", "run_id", "session_name", "runner_id")
             VALUES ($1, $2, 'default', $3)`,
            [randomUUID(), id, ctx.executorId],
          );
        }

        const { secret } = await seedOrchestratorRun(ctx, {
          orchestratorAgentId: orchestrator,
          taskId: null,
          parentRunId: r1,
          rootRunId: r0,
          issueToken: issueOrchestratorRunToken,
        });

        return {
          secret,
          body: {
            target: { agentId: worker },
            mode: "run",
            prompt: "too deep",
          },
        };
      },
    },
    {
      name: "the token carries no run binding",
      code: "PRECONDITION",
      status: 409,
      arrange: async () => {
        const worker = await seedAgent(ctx, { id: "worker" });
        const { secret } = await (
          await import("@/lib/tokens/issue")
        ).issueToken(
          {
            projectId: ctx.projectId,
            name: "ci-token",
            tokenKind: "project",
            scopes: ["runs:delegate"],
          },
          db,
        );

        return {
          secret,
          body: {
            target: { agentId: worker },
            mode: "run",
            prompt: "no parent",
          },
        };
      },
    },
  ];

  describe.each(REFUSAL_CASES)("refuses when $name", (testCase) => {
    it("→ typed refusal at the documented status, and NO child run", async () => {
      const { secret, body } = await testCase.arrange();
      const runsBefore = await countRows(ctx, "runs");

      const res = await delegatePost(delegateRequest(secret, body), {});

      expect(res.status).toBe(testCase.status);
      expect(((await res.json()) as { code: string }).code).toBe(testCase.code);
      expect(await countRows(ctx, "runs")).toBe(runsBefore);
    });
  });
});
