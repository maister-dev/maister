import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
let planPost: typeof import("@/app/api/v1/ext/runs/plan/route").POST;

const PROFILE_SCHEMA = {
  schemaVersion: 1,
  fields: [
    { name: "summary", type: "string", required: true },
    {
      name: "outcome",
      type: "enum",
      required: true,
      options: ["completed", "blocked", "needs_input"],
    },
    { name: "payload", type: "json", required: true },
  ],
};

/**
 * Give the parent orchestrator a pinned flow revision that carries
 * `result_profiles`, plus the on-disk schema document the install resolved it
 * from. The parent's OWN revision is what `resultProfile` resolves against
 * (ADR-165 D4) — not the child's, and not a live catalog row.
 */
async function seedParentFlowWithProfiles(args: {
  engineMin?: string | null;
  profiles?: Record<string, unknown> | null;
}): Promise<{ flowId: string; revisionId: string }> {
  const installedPath = path.join(agentsRoot, "parent-pkg");

  await mkdir(path.join(installedPath, "schemas"), { recursive: true });
  await writeFile(
    path.join(installedPath, "schemas", "research-result.v1.json"),
    JSON.stringify(PROFILE_SCHEMA),
    "utf8",
  );

  const seeded = await seedFlow(ctx, {
    flowRefId: "parent-pkg",
    installedPath,
    engineMin: args.engineMin === undefined ? "3.7.0" : args.engineMin,
  });

  if (args.profiles !== null) {
    await pool.query(
      `UPDATE "flow_revisions" SET "result_profiles" = $2::jsonb WHERE "id" = $1`,
      [
        seeded.revisionId,
        JSON.stringify(
          args.profiles ?? {
            research: {
              schemaPath: "./schemas/research-result.v1.json",
              schemaStem: "research-result.v1",
              schemaVersion: 1,
              sha256: "c".repeat(64),
              schema: PROFILE_SCHEMA,
            },
          },
        ),
      ],
    );
  }

  return seeded;
}

/** An orchestrator run PINNED to a flow revision (so a profile can resolve). */
async function orchestratorTokenPinnedTo(revisionId: string | null): Promise<{
  secret: string;
  runId: string;
}> {
  const orchestrator = await seedAgent(ctx, { id: "orchestrator" });
  const task = await seedTask(ctx);
  const seeded = await seedOrchestratorRun(ctx, {
    orchestratorAgentId: orchestrator,
    taskId: task.id,
    issueToken: issueOrchestratorRunToken,
  });

  if (revisionId) {
    await pool.query(
      `UPDATE "runs" SET "flow_revision_id" = $2 WHERE id = $1`,
      [seeded.runId, revisionId],
    );
  }

  return seeded;
}

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-deleg-profile-"));
  testDatabase = await startMainPostgresTestDb({
    databaseName: "ext_delegate_result_profile_test",
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

// ADR-165 AC-19 / spec C-5.3-C-5.4. R1-R4 from the run-results refusal table,
// one row per case, driven through BOTH creation routes. Every row asserts the
// typed code, the HTTP status, a discriminating message fragment, and that
// NOTHING was written — `tasks`, `runs` AND `run_results` all unchanged. The
// zero-rows half is the point: profile resolution is physically separate from
// launch, so a refusal can never leave a carrier task or a contract behind.
type ProfileRefusalCase = {
  name: string;
  messageContains: string;
  /** Arrange, then return `{ secret, body }` for the DELEGATE route. */
  arrange: () => Promise<{ secret: string; body: Record<string, unknown> }>;
};

const CASES: ProfileRefusalCase[] = [
  {
    // R1 — the option is agent-only; a flow child declares its own
    // `result.export` and has no profile to select.
    name: "R1: resultProfile on a FLOW target",
    messageContains: "resultProfile is agent-target only",
    arrange: async () => {
      const parent = await seedParentFlowWithProfiles({});

      await seedFlow(ctx, { flowRefId: "delegated-flow" });
      const { secret } = await orchestratorTokenPinnedTo(parent.revisionId);

      return {
        secret,
        body: {
          target: { flowId: "delegated-flow" },
          mode: "run",
          prompt: "do the governed thing",
          resultProfile: "research",
        },
      };
    },
  },
  {
    // R2 — a persistent child never runs to terminal, and the result is
    // published in the TERMINAL transaction. The combination is unsatisfiable,
    // so it is refused rather than silently never producing a result.
    name: "R2: resultProfile together with persistent:true",
    messageContains: "resultProfile is not supported for persistent children",
    arrange: async () => {
      const parent = await seedParentFlowWithProfiles({});
      const agentId = await seedAgent(ctx, { id: "researcher" });
      const { secret } = await orchestratorTokenPinnedTo(parent.revisionId);

      return {
        secret,
        body: {
          target: { agentId },
          mode: "run",
          prompt: "research the auth flow",
          persistent: true,
          addressableKey: "researcher-1",
          resultProfile: "research",
        },
      };
    },
  },
  {
    // R3 — the name is resolved through an ALLOW-LIST keyed on the parent's
    // pinned revision. An unknown name is a refusal, never a fallback.
    name: "R3: a name that is not a key of the parent's pinned result_profiles",
    messageContains: "unknown result profile",
    arrange: async () => {
      const parent = await seedParentFlowWithProfiles({});
      const agentId = await seedAgent(ctx, { id: "researcher" });
      const { secret } = await orchestratorTokenPinnedTo(parent.revisionId);

      return {
        secret,
        body: {
          target: { agentId },
          mode: "run",
          prompt: "research the auth flow",
          resultProfile: "no-such-profile",
        },
      };
    },
  },
  {
    // R3 (second arm) — the parent's revision declares NO profiles at all.
    // Distinct from "unknown name" only in the fixture, identical in contract:
    // the allow-list is empty, so nothing resolves.
    name: "R3: a parent revision that declares no result_profiles at all",
    messageContains: "unknown result profile",
    arrange: async () => {
      const parent = await seedParentFlowWithProfiles({ profiles: null });
      const agentId = await seedAgent(ctx, { id: "researcher" });
      const { secret } = await orchestratorTokenPinnedTo(parent.revisionId);

      return {
        secret,
        body: {
          target: { agentId },
          mode: "run",
          prompt: "research the auth flow",
          resultProfile: "research",
        },
      };
    },
  },
  {
    // R4 — the engine floor. Without an explicit guard a pre-3.7.0 parent whose
    // revision happens to carry a profile map would silently gain the feature.
    name: "R4: the parent flow's engine_min is below 3.7.0",
    messageContains: "3.7.0",
    arrange: async () => {
      const parent = await seedParentFlowWithProfiles({ engineMin: "3.6.0" });
      const agentId = await seedAgent(ctx, { id: "researcher" });
      const { secret } = await orchestratorTokenPinnedTo(parent.revisionId);

      return {
        secret,
        body: {
          target: { agentId },
          mode: "run",
          prompt: "research the auth flow",
          resultProfile: "research",
        },
      };
    },
  },
];

async function countResultRows(): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM "run_results"`);

  return r.rows[0].n;
}

describe("resultProfile refusal table (ADR-165 R1-R4)", () => {
  describe.each(CASES)("$name", (testCase) => {
    it("run_delegate → CONFIG 422 and ZERO rows written", async () => {
      const { secret, body } = await testCase.arrange();

      const runsBefore = await countRows(ctx, "runs");
      const tasksBefore = await countRows(ctx, "tasks");
      const resultsBefore = await countResultRows();

      const res = await delegatePost(delegateRequest(secret, body), {});

      expect(res.status).toBe(422);
      const json = (await res.json()) as { code: string; message: string };

      expect(json.code).toBe("CONFIG");
      expect(json.message).toContain(testCase.messageContains);
      expect(await countRows(ctx, "runs")).toBe(runsBefore);
      expect(await countRows(ctx, "tasks")).toBe(tasksBefore);
      expect(await countResultRows()).toBe(resultsBefore);
    });

    it("run_plan → CONFIG 422 and ZERO rows written", async () => {
      const { secret, body } = await testCase.arrange();
      const { target, prompt, persistent, resultProfile } = body as {
        target: unknown;
        prompt: string;
        persistent?: boolean;
        resultProfile?: string;
      };

      const runsBefore = await countRows(ctx, "runs");
      const tasksBefore = await countRows(ctx, "tasks");
      const resultsBefore = await countResultRows();

      const res = await planPost(
        planRequest(secret, {
          tasks: [
            {
              key: "a",
              target,
              prompt,
              dependsOn: [],
              ...(persistent !== undefined ? { persistent } : {}),
              ...(resultProfile !== undefined ? { resultProfile } : {}),
            },
          ],
        }),
        {},
      );

      expect(res.status).toBe(422);
      const json = (await res.json()) as { code: string; message: string };

      expect(json.code).toBe("CONFIG");
      expect(await countRows(ctx, "runs")).toBe(runsBefore);
      expect(await countRows(ctx, "tasks")).toBe(tasksBefore);
      expect(await countResultRows()).toBe(resultsBefore);
    });
  });

  // The positive arm. Every allow-list gets one (patch 2026-08-06-19.10): a
  // refusal table with no accepting case can be satisfied by refusing
  // everything.
  it("accepts a known profile on an agent target and snapshots the contract", async () => {
    const parent = await seedParentFlowWithProfiles({});
    const agentId = await seedAgent(ctx, { id: "researcher" });
    const { secret } = await orchestratorTokenPinnedTo(parent.revisionId);

    const res = await delegatePost(
      delegateRequest(secret, {
        target: { agentId },
        mode: "run",
        prompt: "research the auth flow",
        resultProfile: "research",
      }),
      {},
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as { childRunId: string; status?: string };

    expect(json.childRunId).toBeTruthy();

    const rows = await pool.query(
      `SELECT "result_contract" AS c FROM "runs" WHERE id = $1`,
      [json.childRunId],
    );
    const contract = rows.rows[0].c as Record<string, unknown>;

    expect(contract).toMatchObject({
      kind: "agent_profile",
      profileName: "research",
      required: true,
    });
    // The schemaRef is derived from the PARENT's pinned revision — flowRefId,
    // the first 12 chars of resolved_revision, and the schema stem.
    expect(contract.schemaRef).toBe(
      "parent-pkg@rev-parent-p:research-result.v1",
    );
    expect(typeof contract.sha256).toBe("string");
  });

  it("run_plan records the profile on the created task's delegation_spec", async () => {
    const parent = await seedParentFlowWithProfiles({});
    const agentId = await seedAgent(ctx, {
      id: "researcher",
      triggers: ["manual", "domain_event"],
    });
    const { secret } = await orchestratorTokenPinnedTo(parent.revisionId);

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "a",
            target: { agentId },
            prompt: "research the auth flow",
            dependsOn: [],
            resultProfile: "research",
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(202);
    const rows = await pool.query(
      `SELECT "delegation_spec" AS s FROM "tasks" WHERE "delegation_spec" IS NOT NULL`,
    );

    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].s).toMatchObject({ resultProfile: "research" });
  });
});
