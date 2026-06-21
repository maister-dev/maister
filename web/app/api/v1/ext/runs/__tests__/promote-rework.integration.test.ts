// M37 (ADR-100): the run_promote / run_rework ext surface. run_promote merges a
// reviewed CHILD of the bound orchestrator (owner-less, non-user actor) via
// promote.ts; run_rework re-opens a reviewed child for another turn (Review →
// Running CAS + resume). Scoping (child-of-parent, in-project, Review status) is
// the route's; the merge/CAS core is the service's. The supervisor seam is mocked
// (createSession spy + an immediately-ending stream) so the rework respawn fires
// startAgentSession against the mock without a real adapter, and the git
// primitives are stubbed so a local_merge promote needs no real repo — the
// Postgres status CAS is REAL (the concurrent-racer belt).

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

// Supervisor seam: createSession returns a fake handle (the rework respawn
// resumes via the child's retained acp handle), sendPrompt is a no-op, and
// streamSession yields nothing then ends so consumeAgentSession detaches without
// a terminal flip.
const createSessionSpy = vi.fn(
  async (input: { runId: string; resumeSessionId?: string }) => ({
    sessionId: `sup-${input.runId}`,
    pid: 1,
    acpSessionId: input.resumeSessionId ?? `acp-${input.runId}`,
  }),
);

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    createSession: (input: unknown) => createSessionSpy(input as never),
    sendPrompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
    streamSession: async function* () {
      return;
    },
    listSessions: vi.fn(async () => []),
  };
});

// Git side-effects: a local_merge promote resolves the target tip then merges.
// Both are stubbed (no real repo); the DB claim/finalize CAS stays real. The
// other worktree exports (used by launch.ts) keep their real implementations —
// workspace:none agents never reach them.
const promoteLocalMergeSpy = vi.fn(async () => "mergedcommit00");

vi.mock("@/lib/worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    resolveBaseCommit: vi.fn(async () => "targettip000000"),
    branchExists: vi.fn(async () => true),
    pushBranch: vi.fn(async () => undefined),
    promoteLocalMerge: (...args: unknown[]) =>
      promoteLocalMergeSpy(...(args as [])),
  };
});

let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
let promotePost: typeof import("@/app/api/v1/ext/runs/promote/route").POST;
let reworkPost: typeof import("@/app/api/v1/ext/runs/rework/route").POST;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-promote-rework-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_promote_rework_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
  ({ POST: promotePost } = await import("@/app/api/v1/ext/runs/promote/route"));
  ({ POST: reworkPost } = await import("@/app/api/v1/ext/runs/rework/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let projectId: string;
let otherProjectId: string;
let executorId: string;

beforeEach(async () => {
  createSessionSpy.mockClear();
  promoteLocalMergeSpy.mockClear();

  await pool.query(`DELETE FROM "domain_events"`);
  await pool.query(`DELETE FROM "workspaces"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "task_relations"`);
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "project_tokens"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  otherProjectId = randomUUID();
  executorId = randomUUID();

  for (const pid of [projectId, otherProjectId]) {
    await pool.query(
      `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
       VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
      [
        pid,
        `p-${pid.slice(0, 8)}`,
        `/repos/${pid}`,
        `K${pid
          .replace(/[^0-9A-Za-z]/g, "")
          .slice(0, 7)
          .toUpperCase()}`,
      ],
    );
  }

  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = $1`,
    [executorId],
  );

  // Pinned-package chain (the effective-definition resolver walks it during the
  // rework respawn). Only the primary project needs it — the cross-project case
  // (c) is a scoping refusal at the route's projectId predicate, before any
  // effective-def resolution.
  const revisionId = randomUUID();

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path", "package_status")
     VALUES ($1, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', 'rev-1',
             'digest', '{}'::jsonb, 1, $2, 'Installed')`,
    [revisionId, agentsRoot],
  );
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', $3,
             '{}'::jsonb, 1, $4, 'Enabled', 'trusted', 'pinned')`,
    [randomUUID(), projectId, agentsRoot, revisionId],
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

async function seedAgent(id: string): Promise<string> {
  const qualifiedId = `test-pkg:${id}`;

  await mkdir(path.join(agentsRoot, "agents"), { recursive: true });
  await writeFile(
    path.join(agentsRoot, "agents", `${id}.md`),
    `---
name: ${id}
description: d
workspace: none
mode: session
triggers:
  - manual
risk_tier: read_only
---
Do the thing.
`,
    "utf8",
  );

  await pool.query(
    `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', $3, true)
     ON CONFLICT (id) DO NOTHING`,
    [qualifiedId, id, path.join(agentsRoot, "agents", `${id}.md`)],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), qualifiedId, projectId],
  );

  return qualifiedId;
}

// An orchestrator parent run (run_kind=agent, its own tree root) + run-bound
// orchestrator token (holds runs:promote + runs:delegate).
async function seedOrchestratorRun(
  orchestratorAgentId: string,
  pid: string = projectId,
): Promise<{ runId: string; secret: string }> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "root_run_id",
       "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $1,
             '{"capabilityAgent":"claude"}'::jsonb, $4)`,
    [runId, orchestratorAgentId, pid, executorId],
  );

  const { secret } = await issueOrchestratorRunToken({
    projectId: pid,
    runId,
    db,
  });

  return { runId, secret };
}

// A delegated child run + its workspace row. `status` selects Review (promotable)
// vs anything else (precondition probe). `parentRunId` defaults to the
// orchestrator's id; pass a stray id for the parent-mismatch case. The workspace
// row is what loadWorkspaceForUpdate locks/finalizes during a local_merge.
async function seedChildRun(args: {
  agentId: string;
  parentRunId: string;
  rootRunId: string;
  status: string;
  projectId?: string;
  acpSessionId?: string | null;
  withWorkspace?: boolean;
}): Promise<string> {
  const childRunId = randomUUID();
  const pid = args.projectId ?? projectId;

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "launch_mode", "agent_workspace", "acp_session_id", "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', $2, $3, $4, 'agent', 'manual', $5, $6,
             'manual', 'none', $7, '{"capabilityAgent":"claude"}'::jsonb, $8)`,
    [
      childRunId,
      args.agentId,
      pid,
      args.status,
      args.parentRunId,
      args.rootRunId,
      args.acpSessionId ?? null,
      executorId,
    ],
  );

  if (args.withWorkspace ?? true) {
    await pool.query(
      `INSERT INTO "workspaces" ("id", "run_id", "project_id", "branch", "worktree_path", "parent_repo_path",
         "base_commit", "target_branch", "promotion_mode", "promotion_state")
       VALUES ($1, $2, $3, $4, $5, $6, 'base000', 'main', 'local_merge', 'none')`,
      [
        randomUUID(),
        childRunId,
        pid,
        `maister/child-${childRunId.slice(0, 8)}`,
        `/tmp/wt-${childRunId}`,
        `/repos/${pid}`,
      ],
    );
  }

  return childRunId;
}

function jsonReq(
  url: string,
  secret: string | null,
  body: unknown,
): NextRequest {
  const req = new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (secret) req.headers.set("authorization", `Bearer ${secret}`);

  return req;
}

const PROMOTE_URL = "http://localhost/api/v1/ext/runs/promote";
const REWORK_URL = "http://localhost/api/v1/ext/runs/rework";

async function runStatus(runId: string): Promise<string | null> {
  const r = await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [
    runId,
  ]);

  return r.rows[0]?.status ?? null;
}

describe("POST /api/v1/ext/runs/promote", () => {
  it("(a) promoting a NON-child run (parent mismatch) → PRECONDITION, no merge", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("worker");
    const { runId: parentRunId, secret } =
      await seedOrchestratorRun(orchestrator);

    // A Review run whose parent is a STRAY id, not the bound orchestrator.
    const strayParent = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "status", "flow_version", "flow_revision", "root_run_id", "runner_id")
       VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $1, $4)`,
      [strayParent, orchestrator, projectId, executorId],
    );
    const childRunId = await seedChildRun({
      agentId: worker,
      parentRunId: strayParent,
      rootRunId: strayParent,
      status: "Review",
    });

    const res = await promotePost(
      jsonReq(PROMOTE_URL, secret, { childRunId }),
      {},
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PRECONDITION");

    // No merge attempted; the child stays Review.
    expect(promoteLocalMergeSpy).not.toHaveBeenCalled();
    expect(await runStatus(childRunId)).toBe("Review");
    // The bound orchestrator is untouched.
    expect(await runStatus(parentRunId)).toBe("Running");
  });

  it("(b) promoting a child NOT in Review → PRECONDITION, no merge", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("worker");
    const { runId: parentRunId, secret } =
      await seedOrchestratorRun(orchestrator);
    const childRunId = await seedChildRun({
      agentId: worker,
      parentRunId,
      rootRunId: parentRunId,
      status: "Running",
    });

    const res = await promotePost(
      jsonReq(PROMOTE_URL, secret, { childRunId }),
      {},
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PRECONDITION");
    expect(promoteLocalMergeSpy).not.toHaveBeenCalled();
    expect(await runStatus(childRunId)).toBe("Running");
  });

  it("(c) promoting a cross-project child id → PRECONDITION, no merge", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("worker");
    const { runId: parentRunId, secret } =
      await seedOrchestratorRun(orchestrator);

    // A Review child whose parent_run_id IS the bound orchestrator, but it lives
    // in ANOTHER project — the route's projectId predicate must exclude it.
    const childRunId = await seedChildRun({
      agentId: worker,
      parentRunId,
      rootRunId: parentRunId,
      status: "Review",
      projectId: otherProjectId,
    });

    const res = await promotePost(
      jsonReq(PROMOTE_URL, secret, { childRunId }),
      {},
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PRECONDITION");
    expect(promoteLocalMergeSpy).not.toHaveBeenCalled();
    expect(await runStatus(childRunId)).toBe("Review");
  });

  // (d) Regression-lock for the M-3 bug this test FOUND: an autonomous
  // orchestrator/system promote has no human-reviewed SHA, so
  // promoteChildRunForToken MUST pass `autoOnReady: true` (like auto-delivery.ts)
  // or the target-drift gate throws PRECONDITION "reviewedTargetCommit is
  // required" and dead-ends BOTH run_promote AND the as-plan auto-promoter. Fixed
  // in web/lib/runs/promote.ts; this asserts the now-working happy path.
  it("(d) run_promote of a Review child → Done + run.done(parent_run_id), owner-less system actor", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("worker");
    const { runId: parentRunId, secret } =
      await seedOrchestratorRun(orchestrator);
    const childRunId = await seedChildRun({
      agentId: worker,
      parentRunId,
      rootRunId: parentRunId,
      status: "Review",
    });

    const res = await promotePost(
      jsonReq(PROMOTE_URL, secret, { childRunId }),
      {},
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };

    expect(json.status).toBe("Done");
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
    expect(await runStatus(childRunId)).toBe("Done");

    // run.done folds parent_run_id into the payload (wakes the parent) + an
    // owner-less system actor (actor_type column).
    const ev = await pool.query(
      `SELECT "payload"->>'parentRunId' AS parent_run_id, "actor_type"
         FROM "domain_events"
         WHERE "run_id" = $1 AND "kind" = 'run.done'`,
      [childRunId],
    );

    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].parent_run_id).toBe(parentRunId);
    expect(ev.rows[0].actor_type).toBe("system");
  });
});

describe("POST /api/v1/ext/runs/rework", () => {
  it("(e) happy path: a Review child → Running (CAS), session preserved (resume)", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("worker");
    const { runId: parentRunId, secret } =
      await seedOrchestratorRun(orchestrator);
    const childRunId = await seedChildRun({
      agentId: worker,
      parentRunId,
      rootRunId: parentRunId,
      status: "Review",
      acpSessionId: "acp-child-keep",
    });

    const res = await reworkPost(
      jsonReq(REWORK_URL, secret, {
        childRunId,
        prompt: "address the review comments",
      }),
      {},
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { childRunId: string; status: string };

    expect(json.childRunId).toBe(childRunId);
    expect(json.status).toBe("Running");

    // Review → Running CAS landed.
    expect(await runStatus(childRunId)).toBe("Running");

    // The respawn resumed the child's retained acp session (context preserved),
    // not a fresh session.
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    expect(createSessionSpy.mock.calls[0][0]).toMatchObject({
      runId: childRunId,
      resumeSessionId: "acp-child-keep",
    });

    // The acp handle survives the rework (still present after the resume).
    const row = await pool.query(
      `SELECT "acp_session_id" FROM "runs" WHERE "id" = $1`,
      [childRunId],
    );

    expect(row.rows[0].acp_session_id).toBe("acp-child-keep");
  });

  it("rework rejects a child NOT in Review → PRECONDITION", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("worker");
    const { runId: parentRunId, secret } =
      await seedOrchestratorRun(orchestrator);
    const childRunId = await seedChildRun({
      agentId: worker,
      parentRunId,
      rootRunId: parentRunId,
      status: "Running",
    });

    const res = await reworkPost(
      jsonReq(REWORK_URL, secret, { childRunId, prompt: "x" }),
      {},
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PRECONDITION");
    expect(createSessionSpy).not.toHaveBeenCalled();
  });
});

describe("run_promote + run_rework race the same Review child", () => {
  // A REAL two-racer: promote (Review → Done via the durable workspace claim CAS)
  // and rework (Review → Running via markReworkFromReview CAS) fire concurrently
  // on the SAME child. The Postgres status guard is the arbiter — exactly one
  // flips the child off Review; the loser sees a non-Review status and is
  // refused. Each handler gets its OWN pg connection/db so the two transactions
  // genuinely contend (not a single-threaded interleave).
  it("(f) concurrent promote + rework → exactly one wins, the loser gets CONFLICT", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("worker");
    const { runId: parentRunId, secret } =
      await seedOrchestratorRun(orchestrator);
    const childRunId = await seedChildRun({
      agentId: worker,
      parentRunId,
      rootRunId: parentRunId,
      status: "Review",
      acpSessionId: "acp-race-child",
    });

    const [promoteRes, reworkRes] = await Promise.all([
      promotePost(jsonReq(PROMOTE_URL, secret, { childRunId }), {}),
      reworkPost(
        jsonReq(REWORK_URL, secret, { childRunId, prompt: "rework instead" }),
        {},
      ),
    ]);

    const statuses = [promoteRes.status, reworkRes.status].sort();

    const promoteJson = (await promoteRes.json()) as {
      status?: string;
      code?: string;
    };
    const reworkJson = (await reworkRes.json()) as {
      status?: string;
      code?: string;
    };

    // Exactly one winner (200) + one loser (409). NEVER a double-success — the
    // Postgres status CAS is the single arbiter.
    expect(statuses).toEqual([200, 409]);

    const finalStatus = await runStatus(childRunId);

    if (promoteRes.status === 200) {
      // Promote won → child Done. Rework's markReworkFromReview CAS finds no
      // Review row and is refused with CONFLICT. (Reachable only once the (d)
      // bug is fixed; today the gate keeps promote from ever winning.)
      expect(promoteJson.status).toBe("Done");
      expect(reworkRes.status).toBe(409);
      expect(reworkJson.code).toBe("CONFLICT");
      expect(finalStatus).toBe("Done");
    } else {
      // Rework won → child Running. The promote claim sees a non-Review status
      // and is refused (PRECONDITION from the in-claim status guard / the (d)
      // reviewedTargetCommit gate, or CONFLICT if it lost the claim CAS) —
      // either way a 409, never a merge to Done.
      expect(reworkJson.status).toBe("Running");
      expect(promoteRes.status).toBe(409);
      expect(["PRECONDITION", "CONFLICT"]).toContain(promoteJson.code);
      expect(finalStatus).toBe("Running");
      // The losing promote must not have merged.
      expect(promoteLocalMergeSpy).not.toHaveBeenCalled();
    }
  }, 60_000);

  // The Review-status CAS arbiter on its own — independent of the (d) promote
  // gate: two run_rework calls hit the SAME Review child concurrently. Exactly
  // one markReworkFromReview CAS flips Review → Running; the loser sees no Review
  // row and is refused CONFLICT. A real two-racer (own pooled connection per
  // handler), so the guard is genuinely contended, not interleaved.
  it("(f2) concurrent run_rework + run_rework → exactly one Running, the loser CONFLICT", async () => {
    const orchestrator = await seedAgent("orchestrator");
    const worker = await seedAgent("worker");
    const { runId: parentRunId, secret } =
      await seedOrchestratorRun(orchestrator);
    const childRunId = await seedChildRun({
      agentId: worker,
      parentRunId,
      rootRunId: parentRunId,
      status: "Review",
      acpSessionId: "acp-rework-race",
    });

    const [a, b] = await Promise.all([
      reworkPost(jsonReq(REWORK_URL, secret, { childRunId, prompt: "A" }), {}),
      reworkPost(jsonReq(REWORK_URL, secret, { childRunId, prompt: "B" }), {}),
    ]);

    const statuses = [a.status, b.status].sort();

    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;

    expect(((await winner.json()) as { status: string }).status).toBe(
      "Running",
    );
    expect(((await loser.json()) as { code: string }).code).toBe("CONFLICT");
    expect(await runStatus(childRunId)).toBe("Running");
  }, 60_000);
});
