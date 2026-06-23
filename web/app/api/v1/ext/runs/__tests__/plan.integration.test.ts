// M37 Phase 4 (T4.1, ADR-098): the run_plan ext route emits a task-DAG of
// as-plan child tasks under the calling orchestrator. Mirrors the Phase-3
// delegate suite's container + seed helpers. tryStartRun is stubbed off so the
// source launch leaves a stable Pending run with every delegation column set.

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

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

let issueOrchestratorRunToken: typeof import("@/lib/agents/tokens").issueOrchestratorRunToken;
let planPost: typeof import("@/app/api/v1/ext/runs/plan/route").POST;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-plan-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("ext_plan_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ issueOrchestratorRunToken } = await import("@/lib/agents/tokens"));
  ({ POST: planPost } = await import("@/app/api/v1/ext/runs/plan/route"));
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

async function seedAgent(args: { id: string }): Promise<string> {
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
  - domain_event
risk_tier: read_only
---
Do the thing.
`,
    "utf8",
  );

  await pool.query(
    `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', 'none', 'session', '["manual","domain_event"]'::jsonb, 'read_only', $3, true)`,
    [qualifiedId, args.id, path.join(agentsRoot, "maister-agents", `${args.id}.md`)],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
    [randomUUID(), qualifiedId, projectId],
  );

  return qualifiedId;
}

async function seedOrchestratorRun(args: {
  orchestratorAgentId: string;
  taskId?: string | null;
}): Promise<{ runId: string; secret: string }> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "task_id",
       "status", "flow_version", "flow_revision", "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', $2, $3, $4, 'Running', 'agent', 'manual',
             '{"capabilityAgent":"claude"}'::jsonb, $5)`,
    [
      runId,
      args.orchestratorAgentId,
      projectId,
      args.taskId ?? null,
      executorId,
    ],
  );

  const { secret } = await issueOrchestratorRunToken({ projectId, runId, db });

  return { runId, secret };
}

async function seedOrchestratorTask(): Promise<string> {
  const id = randomUUID();
  const number = Math.trunc(Math.random() * 1e9) + 1;

  await pool.query(
    `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status", "stage", "attempt_number")
     VALUES ($1, $2, $3, 'Orchestrator task', 'coordinate', 'InFlight', 'InFlight', 1)`,
    [id, projectId, number],
  );

  return id;
}

function planRequest(secret: string | null, body: unknown): NextRequest {
  const req = new NextRequest("http://localhost/api/v1/ext/runs/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (secret) req.headers.set("authorization", `Bearer ${secret}`);

  return req;
}

async function countTasks(): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM "tasks"`);

  return r.rows[0].n;
}

describe("POST /api/v1/ext/runs/plan", () => {
  it("(2) a diamond DAG creates 4 as-plan tasks + requires/parent_of edges; only the source launches", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });
    const orchTaskId = await seedOrchestratorTask();
    const { runId: parentRunId, secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: orchTaskId,
    });

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "A",
            target: { agentId: worker },
            prompt: "do A",
            dependsOn: [],
          },
          {
            key: "B",
            target: { agentId: worker },
            prompt: "do B",
            dependsOn: ["A"],
          },
          {
            key: "C",
            target: { agentId: worker },
            prompt: "do C",
            dependsOn: ["A"],
          },
          {
            key: "D",
            target: { agentId: worker },
            prompt: "do D",
            dependsOn: ["B", "C"],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as {
      tasks: { key: string; taskId: string; childRunId?: string }[];
    };

    expect(json.tasks).toHaveLength(4);

    const byKey = new Map(json.tasks.map((t) => [t.key, t]));

    // 4 as-plan tasks created (+ the orchestrator's task already present = 5).
    expect(await countTasks()).toBe(5);

    // All four are launch_mode='auto' with delegation_spec.agentId set.
    for (const key of ["A", "B", "C", "D"]) {
      const row = await pool.query(
        `SELECT "launch_mode", "delegation_spec" FROM "tasks" WHERE "id" = $1`,
        [byKey.get(key)!.taskId],
      );

      expect(row.rows[0].launch_mode).toBe("auto");
      expect(row.rows[0].delegation_spec.agentId).toBe(worker);
    }

    // parent_of from the orchestrator's task → all 4 children.
    const parentOf = await pool.query(
      `SELECT "to_task_id" FROM "task_relations"
       WHERE "from_task_id" = $1 AND "kind" = 'parent_of'`,
      [orchTaskId],
    );

    expect(new Set(parentOf.rows.map((r) => r.to_task_id))).toEqual(
      new Set(["A", "B", "C", "D"].map((k) => byKey.get(k)!.taskId)),
    );

    // requires edges: B→A, C→A, D→B, D→C.
    const requires = await pool.query(
      `SELECT "from_task_id", "to_task_id" FROM "task_relations" WHERE "kind" = 'requires'`,
    );
    const edges = new Set(
      requires.rows.map((r) => `${r.from_task_id}->${r.to_task_id}`),
    );

    expect(edges).toEqual(
      new Set([
        `${byKey.get("B")!.taskId}->${byKey.get("A")!.taskId}`,
        `${byKey.get("C")!.taskId}->${byKey.get("A")!.taskId}`,
        `${byKey.get("D")!.taskId}->${byKey.get("B")!.taskId}`,
        `${byKey.get("D")!.taskId}->${byKey.get("C")!.taskId}`,
      ]),
    );

    // Only the source A launched a child agent run with parent/root linkage.
    expect(byKey.get("A")!.childRunId).toBeTruthy();
    expect(byKey.get("B")!.childRunId).toBeUndefined();
    expect(byKey.get("C")!.childRunId).toBeUndefined();
    expect(byKey.get("D")!.childRunId).toBeUndefined();

    const childRun = await pool.query(
      `SELECT "parent_run_id", "root_run_id", "task_id", "launch_mode"
       FROM "runs" WHERE "id" = $1`,
      [byKey.get("A")!.childRunId],
    );

    expect(childRun.rows[0].parent_run_id).toBe(parentRunId);
    expect(childRun.rows[0].root_run_id).toBe(parentRunId);
    expect(childRun.rows[0].task_id).toBe(byKey.get("A")!.taskId);
    expect(childRun.rows[0].launch_mode).toBe("auto");

    // B/C/D stay Backlog (no run).
    for (const key of ["B", "C", "D"]) {
      const runs = await pool.query(
        `SELECT count(*)::int AS n FROM "runs" WHERE "task_id" = $1`,
        [byKey.get(key)!.taskId],
      );

      expect(runs.rows[0].n).toBe(0);
    }
  });

  it("(3) a cyclic dependsOn graph → CONFIG, NO task rows written", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });
    const orchTaskId = await seedOrchestratorTask();
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: orchTaskId,
    });

    const before = await countTasks();

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "A",
            target: { agentId: worker },
            prompt: "do A",
            dependsOn: ["B"],
          },
          {
            key: "B",
            target: { agentId: worker },
            prompt: "do B",
            dependsOn: ["A"],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("CONFIG");
    // No as-plan tasks written — only the orchestrator's task remains.
    expect(await countTasks()).toBe(before);
  });

  it("(3b) a plan whose orchestrator already sits at the depth limit → CONFIG, NO task rows", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });
    const orchTaskId = await seedOrchestratorTask();
    const { runId: parentRunId, secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: orchTaskId,
    });

    // Build a run-tree ancestor chain so the orchestrator run sits at DEPTH 2.
    // With MAISTER_ORCHESTRATOR_MAX_DEPTH=3 the route guard is `depth + 1 >= 3`,
    // so this plan's children would land at depth 3 → refused (CONFIG) pre-tx.
    const a1 = randomUUID(); // depth 0 (no parent)
    const a2 = randomUUID(); // depth 1 (parent a1)

    for (const [id, parent] of [
      [a1, null],
      [a2, a1],
    ] as const) {
      await pool.query(
        `INSERT INTO "runs" ("id", "run_kind", "project_id", "status",
           "flow_version", "flow_revision", "runner_id", "parent_run_id", "root_run_id")
         VALUES ($1, 'agent', $2, 'Running', 'agent', 'manual', $3, $4, $5)`,
        [id, projectId, executorId, parent, a1],
      );
    }
    await pool.query(
      `UPDATE "runs" SET "parent_run_id" = $1, "root_run_id" = $2 WHERE "id" = $3`,
      [a2, a1, parentRunId],
    );

    const before = await countTasks();

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "X",
            target: { agentId: worker },
            prompt: "do X",
            dependsOn: [],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(422);
    const json = (await res.json()) as { code: string; message: string };

    expect(json.code).toBe("CONFIG");
    expect(json.message).toMatch(/depth/i);
    expect(await countTasks()).toBe(before);
  }, 60_000);

  it("(4) fan-out over MAISTER_MAX_ORCHESTRATOR_FANOUT → CONFIG, NO task rows", async () => {
    process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT = "2";

    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });
    const orchTaskId = await seedOrchestratorTask();
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: orchTaskId,
    });

    const before = await countTasks();

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          { key: "A", target: { agentId: worker }, prompt: "a", dependsOn: [] },
          { key: "B", target: { agentId: worker }, prompt: "b", dependsOn: [] },
          { key: "C", target: { agentId: worker }, prompt: "c", dependsOn: [] },
        ],
      }),
      {},
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("CONFIG");
    expect(await countTasks()).toBe(before);

    delete process.env.MAISTER_MAX_ORCHESTRATOR_FANOUT;
  });

  it("an unknown dependsOn key → CONFIG, NO task rows", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const worker = await seedAgent({ id: "worker" });
    const orchTaskId = await seedOrchestratorTask();
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: orchTaskId,
    });

    const before = await countTasks();

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "A",
            target: { agentId: worker },
            prompt: "a",
            dependsOn: ["ghost"],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("CONFIG");
    expect(await countTasks()).toBe(before);
  });

  it("an unresolvable target agent → PRECONDITION, NO task rows", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const orchTaskId = await seedOrchestratorTask();
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: orchTaskId,
    });

    const before = await countTasks();

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          {
            key: "A",
            target: { agentId: "test-pkg:does-not-exist" },
            prompt: "a",
            dependsOn: [],
          },
        ],
      }),
      {},
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PRECONDITION");
    expect(await countTasks()).toBe(before);
  });

  it("a token with NO run binding → PRECONDITION", async () => {
    const worker = await seedAgent({ id: "worker" });

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

    const res = await planPost(
      planRequest(secret, {
        tasks: [
          { key: "A", target: { agentId: worker }, prompt: "a", dependsOn: [] },
        ],
      }),
      {},
    );

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("PRECONDITION");
  });

  it("an empty tasks array → CONFIG", async () => {
    const orchestrator = await seedAgent({ id: "orchestrator" });
    const orchTaskId = await seedOrchestratorTask();
    const { secret } = await seedOrchestratorRun({
      orchestratorAgentId: orchestrator,
      taskId: orchTaskId,
    });

    const res = await planPost(planRequest(secret, { tasks: [] }), {});

    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("CONFIG");
  });
});
