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

// getDb() → the testcontainer everywhere (routes, services, the workbench stop
// dispatcher's module-level db()). tryStartRun is forced to NOT promote so the
// agent-session spawn microtask never fires — the run row stays a stable
// Pending with every delegation column set at INSERT.
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
let delegatePost: typeof import("@/app/api/v1/ext/runs/delegate/route").POST;
let collectPost: typeof import("@/app/api/v1/ext/runs/collect/route").POST;
let cancelPost: typeof import("@/app/api/v1/ext/runs/cancel/route").POST;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-delegate-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_delegate_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
  ({ POST: delegatePost } = await import(
    "@/app/api/v1/ext/runs/delegate/route"
  ));
  ({ POST: collectPost } = await import("@/app/api/v1/ext/runs/collect/route"));
  ({ POST: cancelPost } = await import("@/app/api/v1/ext/runs/cancel/route"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let projectId: string;
let executorId: string;

beforeEach(async () => {
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
  executorId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      `/repos/${projectId}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );

  await (db as any)
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = $1`,
    [executorId],
  );

  // The pinned-package chain the effective-definition resolver walks.
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

// Seeds the agent definition file + catalog index row + project link. Returns
// the package-qualified id. `enabled` toggles the agents-row kill switch (the
// disabled path the trust-separation test exercises).
async function seedAgent(args: {
  id: string;
  enabled?: boolean;
}): Promise<string> {
  const qualifiedId = `test-pkg:${args.id}`;

  await mkdir(path.join(agentsRoot, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(agentsRoot, "maister-agents", `${args.id}.md`),
    `---
name: ${args.id}
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
     VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', $3, $4)`,
    [
      qualifiedId,
      args.id,
      path.join(agentsRoot, "maister-agents", `${args.id}.md`),
      args.enabled ?? true,
    ],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
    [randomUUID(), qualifiedId, projectId],
  );

  return qualifiedId;
}

// L-1: seeds an agent shipped by a SEPARATE package whose project flow row is
// untrusted (or disabled). This is the trust contour `resolveEffectiveAgentDefinition`
// enforces SEPARATELY from the agents-row kill switch (test 4): a catalog-enabled
// agent whose PACKAGE is untrusted/disabled must still refuse to launch. Returns
// the package-qualified id. `installedPath` gets its own subtree so the agent
// `.md` is distinct from test-pkg's.
async function seedUntrustedPackageAgent(args: {
  id: string;
  trustStatus?: "trusted" | "untrusted";
  enablementState?: "Enabled" | "Disabled";
}): Promise<string> {
  const flowRefId = "untrusted-pkg";
  const qualifiedId = `${flowRefId}:${args.id}`;
  const installedPath = path.join(agentsRoot, flowRefId);

  await mkdir(path.join(installedPath, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(installedPath, "maister-agents", `${args.id}.md`),
    `---
name: ${args.id}
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

  const revisionId = randomUUID();

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path", "package_status")
     VALUES ($1, $2, 'github.com/acme/untrusted-pkg', 'v1.0.0', 'rev-untrusted',
             'digest', '{}'::jsonb, 1, $3, 'Installed')`,
    [revisionId, flowRefId, installedPath],
  );
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, $3, 'github.com/acme/untrusted-pkg', 'v1.0.0', $4,
             '{}'::jsonb, 1, $5, $6, $7, 'pinned')`,
    [
      randomUUID(),
      projectId,
      flowRefId,
      installedPath,
      revisionId,
      args.enablementState ?? "Enabled",
      args.trustStatus ?? "untrusted",
    ],
  );

  // The catalog row is ENABLED (kill switch OFF) — proving it is the PACKAGE
  // trust contour, not the agents-row flag, that refuses the launch.
  await pool.query(
    `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, $2, 'v1.0.0', 'git', $3, 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', $4, true)`,
    [
      qualifiedId,
      flowRefId,
      args.id,
      path.join(installedPath, "maister-agents", `${args.id}.md`),
    ],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
    [randomUUID(), qualifiedId, projectId],
  );

  return qualifiedId;
}

// Seeds an orchestrator parent run (run_kind=agent) + its run-bound token.
async function seedOrchestratorRun(args: {
  orchestratorAgentId: string;
  taskId?: string | null;
  rootRunId?: string | null;
  parentRunId?: string | null;
}): Promise<{ runId: string; secret: string }> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "task_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', $2, $3, $4, 'Running', 'agent', 'manual', $5, $6,
             '{"capabilityAgent":"claude"}'::jsonb, $7)`,
    [
      runId,
      args.orchestratorAgentId,
      projectId,
      args.taskId ?? null,
      args.parentRunId ?? null,
      args.rootRunId ?? null,
      executorId,
    ],
  );

  const { secret } = await issueOrchestratorRunToken({ projectId, runId, db });

  return { runId, secret };
}

async function seedTask(): Promise<{ id: string; number: number }> {
  const id = randomUUID();
  const number = Math.trunc(Math.random() * 1e9) + 1;

  await pool.query(
    `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status", "stage", "attempt_number")
     VALUES ($1, $2, $3, 'Orchestrator task', 'coordinate', 'InFlight', 'InFlight', 1)`,
    [id, projectId, number],
  );

  return { id, number };
}

function delegateRequest(secret: string | null, body: unknown): NextRequest {
  const req = new NextRequest("http://localhost/api/v1/ext/runs/delegate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (secret) req.headers.set("authorization", `Bearer ${secret}`);

  return req;
}

async function countRuns(): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM "runs"`);

  return r.rows[0].n;
}

describe("POST /api/v1/ext/runs/delegate", () => {
  it("(1) as-task → child task + parent_of relation + child agent run with delegation_snapshot", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });
    const task = await seedTask();
    const { runId: parentRunId, secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: task.id,
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

    // Child task exists in the project.
    const childTaskRows = await pool.query(
      `SELECT "title", "flow_id" FROM "tasks" WHERE "id" = $1`,
      [json.childTaskId],
    );

    expect(childTaskRows.rows).toHaveLength(1);
    expect(childTaskRows.rows[0].title).toBe("Investigate");

    // parent_of from the orchestrator's task to the child task.
    const relRows = await pool.query(
      `SELECT "kind", "to_task_id" FROM "task_relations" WHERE "from_task_id" = $1`,
      [task.id],
    );

    expect(relRows.rows).toHaveLength(1);
    expect(relRows.rows[0].kind).toBe("parent_of");
    expect(relRows.rows[0].to_task_id).toBe(json.childTaskId);

    // Child run carries the linkage + the child's launch-time effective def.
    const childRunRows = await pool.query(
      `SELECT "parent_run_id", "task_id", "delegation_snapshot", "launch_mode"
       FROM "runs" WHERE "id" = $1`,
      [json.childRunId],
    );
    const childRun = childRunRows.rows[0];

    expect(childRun.parent_run_id).toBe(parentRunId);
    expect(childRun.task_id).toBe(json.childTaskId);
    expect(childRun.delegation_snapshot.agentDefinitionId).toBe(worker);
    expect(childRun.delegation_snapshot.revisionId).toBeTruthy();
    expect(childRun.launch_mode).toBe("manual");
  });

  it("(2) as-run → child agent run with parent_run_id and NO task (no board card)", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });
    const { runId: parentRunId, secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
    });

    const res = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "Summarize the diff",
      }),
      {},
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as {
      childRunId: string;
      childTaskId?: string;
    };

    expect(json.childTaskId).toBeUndefined();

    const childRunRows = await pool.query(
      `SELECT "parent_run_id", "task_id" FROM "runs" WHERE "id" = $1`,
      [json.childRunId],
    );

    expect(childRunRows.rows[0].parent_run_id).toBe(parentRunId);
    expect(childRunRows.rows[0].task_id).toBeNull();

    // No task was created at all.
    const taskCount = await pool.query(
      `SELECT count(*)::int AS n FROM "tasks"`,
    );

    expect(taskCount.rows[0].n).toBe(0);
  });

  it("(3) child carries delegation_snapshot + runner_snapshot; root_run_id propagates", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });
    // A parent that is itself a child sets an explicit root distinct from its id.
    const rootId = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "status", "flow_version", "flow_revision", "runner_id")
       VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $4)`,
      [rootId, orchestrator, projectId, executorId],
    );

    const { runId: parentRunId, secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
      parentRunId: rootId,
      rootRunId: rootId,
    });

    const res = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "Nested delegation",
      }),
      {},
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as { childRunId: string };

    const childRunRows = await pool.query(
      `SELECT "parent_run_id", "root_run_id", "delegation_snapshot", "runner_snapshot"
       FROM "runs" WHERE "id" = $1`,
      [json.childRunId],
    );
    const childRun = childRunRows.rows[0];

    expect(childRun.parent_run_id).toBe(parentRunId);
    // root flows from the parent's root, not the parent id.
    expect(childRun.root_run_id).toBe(rootId);
    expect(childRun.delegation_snapshot).not.toBeNull();
    expect(childRun.runner_snapshot).not.toBeNull();
  });

  it("(4) trust separation: delegating to a DISABLED agent → PRECONDITION, NO child run", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const disabled = await seedAgent({ id: "disabled-worker", enabled: false });
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
    });

    const before = await countRuns();

    const res = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: disabled },
        mode: "run",
        prompt: "should never launch",
      }),
      {},
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string };

    expect(json.code).toBe("PRECONDITION");

    // No child run row was created (count unchanged).
    expect(await countRuns()).toBe(before);
  });

  it("(4b) trust separation: delegating to an agent whose PACKAGE is untrusted → PRECONDITION, NO child run", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    // Catalog-enabled agent, but its providing package's project flow row is
    // untrusted — the contour resolveEffectiveAgentDefinition enforces apart from
    // the agents.enabled kill switch (test 4).
    const untrusted = await seedUntrustedPackageAgent({
      id: "untrusted-worker",
      trustStatus: "untrusted",
    });
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
    });

    const before = await countRuns();

    const res = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: untrusted },
        mode: "run",
        prompt: "untrusted package must never launch",
      }),
      {},
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PRECONDITION");

    // The launch was refused BEFORE any child run row was inserted.
    expect(await countRuns()).toBe(before);
    const childCount = await pool.query(
      `SELECT count(*)::int AS n FROM "runs" WHERE "agent_id" = $1`,
      [untrusted],
    );

    expect(childCount.rows[0].n).toBe(0);
  });

  it("(4c) trust separation: delegating to an agent whose PACKAGE is Disabled → PRECONDITION, NO child run", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    // Package is trusted but its project flow row is Disabled (not a launchable
    // enablement state) — the other half of the separately-enforced contour.
    const disabledPkg = await seedUntrustedPackageAgent({
      id: "disabled-pkg-worker",
      trustStatus: "trusted",
      enablementState: "Disabled",
    });
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
    });

    const before = await countRuns();

    const res = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: disabledPkg },
        mode: "run",
        prompt: "disabled package must never launch",
      }),
      {},
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PRECONDITION");

    expect(await countRuns()).toBe(before);
    const childCount = await pool.query(
      `SELECT count(*)::int AS n FROM "runs" WHERE "agent_id" = $1`,
      [disabledPkg],
    );

    expect(childCount.rows[0].n).toBe(0);
  });

  // Finding 1 (Codex adversarial review): a run-bound token outlives its
  // orchestrator on abandon/crash (revocation is best-effort on the normal-exit
  // path only). Every run-bound ext route MUST re-check the bound run is still
  // active via resolveActiveBoundRun, so a stale/copied token cannot mutate a
  // TERMINAL tree. delegate exercises the shared guard for all 7 routes.
  it("(4d) Finding 1: a token whose orchestrator has TERMINALIZED → PRECONDITION, NO child", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });
    const { runId: parentRunId, secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
    });

    // The orchestrator reaches a terminal state — its run-bound token is NOT
    // revoked on this path, so the route's active-parent guard is the defense.
    await pool.query(
      `UPDATE "runs" SET "status" = 'Abandoned', "ended_at" = now() WHERE "id" = $1`,
      [parentRunId],
    );

    const before = await countRuns();

    const res = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "a stale token must not delegate under a terminal tree",
      }),
      {},
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string; message: string };

    expect(json.code).toBe("PRECONDITION");
    expect(json.message).toContain("no longer active");

    // Fail-closed: no child run created under the terminal tree.
    expect(await countRuns()).toBe(before);
  });

  it("(5) depth bound: a parent chain already at MAX_DEPTH → CONFIG, no child", async () => {
    process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH = "2";

    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });

    // Build a 2-deep chain: r0 → r1 (parent_run_id=r0). The bound parent r1 is
    // at depth 1; the depth check counts hops UP from the parent — but we want
    // it AT the limit, so make the bound run itself 2 hops deep.
    const r0 = randomUUID();
    const r1 = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "status", "flow_version", "flow_revision", "runner_id")
       VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $4)`,
      [r0, orchestrator, projectId, executorId],
    );
    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id", "runner_id")
       VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $4, $4, $5)`,
      [r1, orchestrator, projectId, r0, executorId],
    );

    // The bound orchestrator run is r2, child of r1 → parent chain depth = 2.
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
      parentRunId: r1,
      rootRunId: r0,
    });

    const before = await countRuns();

    const res = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "too deep",
      }),
      {},
    );

    expect(res.status).toBe(422);
    const json = (await res.json()) as { code: string };

    expect(json.code).toBe("CONFIG");
    expect(await countRuns()).toBe(before);

    delete process.env.MAISTER_ORCHESTRATOR_MAX_DEPTH;
  });

  it("(6) a token with NO run binding → PRECONDITION (cannot delegate)", async () => {
    const worker = await seedAgent({ id: "worker" });

    // A plain project token (deterministic name without the run-bound prefix).
    const { secret } = await (
      await import("@/lib/tokens/issue")
    ).issueToken(
      {
        projectId,
        name: "ci-token",
        tokenKind: "project",
        scopes: ["runs:delegate"],
      },
      db,
    );

    const res = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "no parent",
      }),
      {},
    );

    expect(res.status).toBe(409);
    const json = (await res.json()) as { code: string };

    expect(json.code).toBe("PRECONDITION");
  });

  it("flow-target delegation is rejected (CONFIG, out of scope)", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
    });

    const res = await delegatePost(
      delegateRequest(secret, {
        target: { flowId: "some-flow" },
        mode: "run",
        prompt: "flow target",
      }),
      {},
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("CONFIG");
  });
});

describe("POST /api/v1/ext/runs/collect + /cancel", () => {
  it("collect all: returns each child with status + empty artifacts", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });
    const { runId: parentRunId, secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
    });

    // Two delegated children.
    const childIds: string[] = [];

    for (let i = 0; i < 2; i += 1) {
      const res = await delegatePost(
        delegateRequest(secret, {
          target: { agentId: worker },
          mode: "run",
          prompt: `child ${i}`,
        }),
        {},
      );

      childIds.push(((await res.json()) as { childRunId: string }).childRunId);
    }

    const collectReq = new NextRequest(
      "http://localhost/api/v1/ext/runs/collect",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      },
    );

    collectReq.headers.set("authorization", `Bearer ${secret}`);

    const res = await collectPost(collectReq, {});

    expect(res.status).toBe(200);
    const results = (await res.json()) as {
      childRunId: string;
      status: string;
      artifacts: unknown[];
    }[];

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.childRunId).sort()).toEqual(childIds.sort());
    for (const r of results) {
      expect(r.status).toBe("Pending");
      expect(r.artifacts).toEqual([]);
    }

    // A foreign run (no parent) is never collected.
    expect(results.every((r) => r.childRunId !== parentRunId)).toBe(true);
  });

  it("collect projects a child's CURRENT artifacts (diffRef + outputText + names; stale excluded)", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
    });

    const delRes = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "child",
      }),
      {},
    );
    const childRunId = ((await delRes.json()) as { childRunId: string })
      .childRunId;

    const insertArtifact = (kind: string, locator: unknown, validity: string) =>
      pool.query(
        `INSERT INTO "artifact_instances" ("id", "run_id", "kind", "producer", "locator", "validity", "visibility")
         VALUES ($1, $2, $3, 'runner', $4::jsonb, $5, 'internal')`,
        [randomUUID(), childRunId, kind, JSON.stringify(locator), validity],
      );

    await insertArtifact(
      "diff",
      {
        kind: "git-range",
        baseCommit: "abcdef0123456789",
        headRef: "maister/child",
      },
      "current",
    );
    await insertArtifact(
      "log",
      { kind: "inline", text: "the child's terminal summary" },
      "current",
    );
    await insertArtifact(
      "generic_file",
      { kind: "file", path: "src/foo.ts" },
      "current",
    );
    // A stale artifact MUST NOT be projected.
    await insertArtifact("log", { kind: "inline", text: "stale" }, "stale");

    const req = new NextRequest("http://localhost/api/v1/ext/runs/collect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ childRunId }),
    });

    req.headers.set("authorization", `Bearer ${secret}`);

    const res = await collectPost(req, {});

    expect(res.status).toBe(200);
    const results = (await res.json()) as Array<{
      childRunId: string;
      status: string;
      artifacts: { id: string; kind: string; name: string }[];
      diffRef?: string;
      outputText?: string;
    }>;

    expect(results).toHaveLength(1);
    const r = results[0];

    expect(r.childRunId).toBe(childRunId);
    // 3 current artifacts projected; the stale one is excluded.
    expect(r.artifacts).toHaveLength(3);
    // git-range diff → diffRef = headRef; inline log → outputText.
    expect(r.diffRef).toBe("maister/child");
    expect(r.outputText).toBe("the child's terminal summary");
    // Projected names: file path verbatim, diff as <base12>..<headRef>.
    const names = r.artifacts.map((a) => a.name);

    expect(names).toContain("src/foo.ts");
    expect(names).toContain("abcdef012345..maister/child");
  });

  it("collect rejects a non-child run (PRECONDITION)", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
    });

    // A run that is NOT a child of the bound orchestrator.
    const strayId = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "status", "flow_version", "flow_revision", "runner_id")
       VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $4)`,
      [strayId, orchestrator, projectId, executorId],
    );

    const req = new NextRequest("http://localhost/api/v1/ext/runs/collect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ childRunId: strayId }),
    });

    req.headers.set("authorization", `Bearer ${secret}`);

    const res = await collectPost(req, {});

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PRECONDITION");
  });

  it("cancel: a Running child of the orchestrator is abandoned", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
    });

    const delRes = await delegatePost(
      delegateRequest(secret, {
        target: { agentId: worker },
        mode: "run",
        prompt: "child to cancel",
      }),
      {},
    );
    const childRunId = ((await delRes.json()) as { childRunId: string })
      .childRunId;

    // The stop action only applies to a live run — bump the Pending child to
    // Running (the spawn microtask is stubbed off in this suite).
    await pool.query(`UPDATE "runs" SET "status" = 'Running' WHERE "id" = $1`, [
      childRunId,
    ]);

    const req = new NextRequest("http://localhost/api/v1/ext/runs/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ childRunId }),
    });

    req.headers.set("authorization", `Bearer ${secret}`);

    const res = await cancelPost(req, {});

    expect(res.status).toBe(200);
    const json = (await res.json()) as { childRunId: string; status: string };

    expect(json.childRunId).toBe(childRunId);
    expect(json.status).toBe("Abandoned");

    const row = await pool.query(
      `SELECT "status" FROM "runs" WHERE "id" = $1`,
      [childRunId],
    );

    expect(row.rows[0].status).toBe("Abandoned");
  });

  it("cancel rejects a non-child run (PRECONDITION)", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: null,
    });

    const strayId = randomUUID();

    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "status", "flow_version", "flow_revision", "runner_id")
       VALUES ($1, 'agent', $2, $3, 'Running', 'agent', 'manual', $4)`,
      [strayId, orchestrator, projectId, executorId],
    );

    const req = new NextRequest("http://localhost/api/v1/ext/runs/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ childRunId: strayId }),
    });

    req.headers.set("authorization", `Bearer ${secret}`);

    const res = await cancelPost(req, {});

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PRECONDITION");
  });
});
