import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let stopWorkbenchRun: typeof import("@/lib/workbench-lifecycle/service").stopWorkbenchRun;
let stopScratchWorkbench: typeof import("@/lib/scratch-runs/service").stopScratchWorkbench;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
// authz is dynamically imported by the default workbench deps; no-op it so the
// integration test exercises the DB-real stop path without a live session.
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => ({
    id: "stop-user",
    email: "stop@test",
    role: "admin",
  })),
  requireProjectAction: vi.fn(async () => undefined),
}));

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("workbench_stop_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ stopWorkbenchRun } = await import("@/lib/workbench-lifecycle/service"));
  ({ stopScratchWorkbench } = await import("@/lib/scratch-runs/service"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "workspaces"`);
  await pool.query(`DELETE FROM "scratch_runs"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "users"`);
  await pool.query(`DELETE FROM "projects"`);
});

async function seedProject(): Promise<string> {
  const projectId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/stop.yaml', $4, 2)`,
    [
      projectId,
      `stop-${projectId.slice(0, 8)}`,
      `/tmp/stop-${projectId.slice(0, 8)}`,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );

  return projectId;
}

describe("workbench stop — agent runs", () => {
  it("terminates a live agent run to Abandoned", async () => {
    const projectId = await seedProject();
    const taskId = randomUUID();
    const runId = randomUUID();

    await pool.query(
      `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
       VALUES ('stop-agent', 'stop-pkg', 'v1.0.0', 'git', 'A', 'd', 'worktree', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/agent.md')`,
    );
    await pool.query(
      `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, 'stop-agent', $2)`,
      [randomUUID(), projectId],
    );
    await pool.query(
      `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt")
       VALUES ($1, $2, 1, 'task', 'prompt')`,
      [taskId, projectId],
    );
    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "agent_workspace", "trigger_source", "task_id", "project_id", "flow_version", "flow_revision", "status", "acp_session_id")
       VALUES ($1, 'agent', 'stop-agent', 'worktree', 'manual', $2, $3, 'agent', 'manual', 'Running', NULL)`,
      [runId, taskId, projectId],
    );

    const result = await stopWorkbenchRun(runId);

    expect(result).toMatchObject({
      ok: true,
      runStatus: "Abandoned",
      supervisorStopped: false,
    });

    const { rows } = await pool.query(
      `SELECT "status", "acp_session_id" FROM "runs" WHERE "id" = $1`,
      [runId],
    );

    expect(rows[0].status).toBe("Abandoned");
    expect(rows[0].acp_session_id).toBeNull();
  });

  it("refuses to stop an already-terminal agent run", async () => {
    const projectId = await seedProject();
    const taskId = randomUUID();
    const runId = randomUUID();

    await pool.query(
      `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
       VALUES ('stop-agent', 'stop-pkg', 'v1.0.0', 'git', 'A', 'd', 'worktree', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/agent.md')`,
    );
    await pool.query(
      `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, 'stop-agent', $2)`,
      [randomUUID(), projectId],
    );
    await pool.query(
      `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt")
       VALUES ($1, $2, 1, 'task', 'prompt')`,
      [taskId, projectId],
    );
    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "agent_id", "agent_workspace", "trigger_source", "task_id", "project_id", "flow_version", "flow_revision", "status")
       VALUES ($1, 'agent', 'stop-agent', 'worktree', 'manual', $2, $3, 'agent', 'manual', 'Abandoned')`,
      [runId, taskId, projectId],
    );

    await expect(stopWorkbenchRun(runId)).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });
});

describe("workbench stop — scratch runs", () => {
  async function seedScratchRun(args: {
    hasWorkspace: boolean;
  }): Promise<{ runId: string }> {
    const projectId = await seedProject();
    const userId = randomUUID();
    const runId = randomUUID();

    await pool.query(
      `INSERT INTO "users" ("id", "email", "role") VALUES ($1, $2, 'admin')`,
      [userId, `u-${userId.slice(0, 8)}@test`],
    );
    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "trigger_source", "project_id", "flow_version", "flow_revision", "status")
       VALUES ($1, 'scratch', 'manual', $2, 'scratch', 'scratch', 'Running')`,
      [runId, projectId],
    );
    await pool.query(
      `INSERT INTO "scratch_runs" ("run_id", "project_id", "initial_prompt", "base_branch", "base_commit", "dialog_status", "supervisor_session_id", "created_by_user_id")
       VALUES ($1, $2, 'do a thing', 'main', 'abc1234', 'WaitingForUser', NULL, $3)`,
      [runId, projectId, userId],
    );

    if (args.hasWorkspace) {
      await pool.query(
        `INSERT INTO "workspaces" ("id", "run_id", "project_id", "branch", "worktree_path", "parent_repo_path")
         VALUES ($1, $2, $3, $4, $5, '/tmp/repo')`,
        [
          randomUUID(),
          runId,
          projectId,
          `maister/${runId}`,
          `/tmp/worktrees/${runId}`,
        ],
      );
    }

    return { runId };
  }

  it("parks a scratch run with a live worktree in Review", async () => {
    const { runId } = await seedScratchRun({ hasWorkspace: true });

    const result = await stopScratchWorkbench(runId);

    expect(result).toMatchObject({
      runStatus: "Review",
      dialogStatus: "Review",
      workspaceActive: true,
    });

    const run = await pool.query(
      `SELECT "status" FROM "runs" WHERE "id" = $1`,
      [runId],
    );
    const scratch = await pool.query(
      `SELECT "dialog_status" FROM "scratch_runs" WHERE "run_id" = $1`,
      [runId],
    );

    expect(run.rows[0].status).toBe("Review");
    expect(scratch.rows[0].dialog_status).toBe("Review");
  });

  it("abandons a scratch run with no live worktree", async () => {
    const { runId } = await seedScratchRun({ hasWorkspace: false });

    const result = await stopScratchWorkbench(runId);

    expect(result).toMatchObject({
      runStatus: "Abandoned",
      dialogStatus: "Abandoned",
      workspaceActive: false,
    });

    const run = await pool.query(
      `SELECT "status" FROM "runs" WHERE "id" = $1`,
      [runId],
    );

    expect(run.rows[0].status).toBe("Abandoned");
  });
});
