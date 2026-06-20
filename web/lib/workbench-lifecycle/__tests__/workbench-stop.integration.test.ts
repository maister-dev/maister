import type {
  LifecycleContext,
  WorkbenchLifecycleDeps,
} from "@/lib/workbench-lifecycle/service";

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
let stopThenArchive: typeof import("@/lib/workbench-lifecycle/service").stopThenArchive;
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

  ({ stopWorkbenchRun, stopThenArchive } = await import(
    "@/lib/workbench-lifecycle/service"
  ));
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

  it("stops then archives a live scratch run with a worktree (combined op)", async () => {
    const { runId } = await seedScratchRun({ hasWorkspace: true });

    // The scratch stop + the post-stop reload run against the real container DB;
    // the git/claim ops are injected spies because the seeded /tmp paths are not
    // real repos. This proves the scratch composition end-to-end: stop parks the
    // run to Review (real DB) and the archive half then dispatches on it.
    const loadContext = vi.fn(
      async (rid: string): Promise<LifecycleContext> => {
        const runRows = await pool.query(
          `SELECT "id","project_id","task_id","run_kind","status","acp_session_id","current_step_id" FROM "runs" WHERE "id" = $1`,
          [rid],
        );
        const run = runRows.rows[0];
        const projRows = await pool.query(
          `SELECT "id","main_branch" FROM "projects" WHERE "id" = $1`,
          [run.project_id],
        );
        const wsRows = await pool.query(
          `SELECT "id","run_id","project_id","branch","worktree_path","parent_repo_path","removed_at","archived_branch","archived_at","base_branch","base_commit" FROM "workspaces" WHERE "run_id" = $1`,
          [rid],
        );
        const proj = projRows.rows[0];
        const ws = wsRows.rows[0] ?? null;

        return {
          project: { id: proj.id, mainBranch: proj.main_branch },
          run: {
            id: run.id,
            projectId: run.project_id,
            taskId: run.task_id ?? null,
            runKind: run.run_kind,
            status: run.status,
            acpSessionId: run.acp_session_id,
            currentStepId: run.current_step_id,
          },
          workspace: ws
            ? {
                id: ws.id,
                runId: ws.run_id,
                projectId: ws.project_id,
                branch: ws.branch,
                worktreePath: ws.worktree_path,
                parentRepoPath: ws.parent_repo_path,
                removedAt: ws.removed_at,
                archivedBranch: ws.archived_branch,
                archivedAt: ws.archived_at,
                baseBranch: ws.base_branch,
                baseCommit: ws.base_commit,
              }
            : null,
        };
      },
    );
    const deps: WorkbenchLifecycleDeps = {
      requireActiveSession: vi.fn(async () => undefined),
      loadContext,
      authorize: vi.fn(async () => undefined),
      listSessions: vi.fn(async () => []),
      deleteSession: vi.fn(async () => undefined),
      markStoppedAndCloseAssignments: vi.fn(async () => undefined),
      promoteNextPending: vi.fn(async () => undefined),
      preserveWorktree: vi.fn(async () => ({
        ok: true,
        archivedBranch: "maister/archive/scratch",
        archivedAt: new Date("2026-06-16T08:00:00.000Z"),
        snapshotted: true,
      })),
      recordArchive: vi.fn(async () => undefined),
      recordDrop: vi.fn(async () => undefined),
      removeOwnedWorktree: vi.fn(async () => undefined),
      worktreesRoot: vi.fn(() => "/tmp/maister/worktrees"),
      statusPorcelain: vi.fn(async () => ""),
      snapshotDirtyWorktree: vi.fn(async () => false),
      pushBranch: vi.fn(async () => undefined),
      claimLifecycleOperation: vi.fn(async () => ({
        attemptId: "scratch-archive-attempt",
      })),
      finalizeLifecycleOperation: vi.fn(async () => undefined),
      listRemotes: vi.fn(async () => ["origin"]),
      headCommit: vi.fn(async () => "abc1234"),
      localBranchHead: vi.fn(async () => null),
      remoteBranchHead: vi.fn(async () => null),
      createBranchAtHead: vi.fn(async () => undefined),
      cascadeOrchestratorIfNeeded: vi.fn(async () => undefined),
    };

    const result = await stopThenArchive(runId, { deps });

    expect(result).toMatchObject({
      ok: true,
      archivedBranch: "maister/archive/scratch",
      supervisorStopped: false,
    });
    expect(deps.preserveWorktree).toHaveBeenCalled();
    expect(deps.recordArchive).toHaveBeenCalledTimes(1);
    expect(deps.claimLifecycleOperation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "archive" }),
    );

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
});

describe("workbench stop — orchestrator cascade (M37 T7.4)", () => {
  async function seedFlow(projectId: string): Promise<string> {
    const flowId = randomUUID();

    await pool.query(
      `INSERT INTO "flows" ("id", "project_id", "flow_ref_id", "source", "version", "installed_path", "manifest", "schema_version")
       VALUES ($1, $2, 'orc', 'github.com/x/y', 'v1.0.0', '/tmp/flows/orc', '{"schemaVersion":1,"name":"Orc","nodes":[]}'::jsonb, 1)`,
      [flowId, projectId],
    );

    return flowId;
  }

  async function seedAgentChild(args: {
    projectId: string;
    flowId: string;
    parentRunId: string;
    status: string;
  }): Promise<string> {
    const taskId = randomUUID();
    const runId = randomUUID();

    await pool.query(
      `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "launch_mode")
       VALUES ($1, $2, $3, 'child', 'p', 'auto')`,
      [taskId, args.projectId, Math.trunc(Math.random() * 1e9) + 1],
    );
    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
         "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id")
       VALUES ($1, 'agent', $2, $3, $4, $5, 'v1.0.0', 'unknown', $6, $6)`,
      [
        runId,
        args.projectId,
        taskId,
        args.flowId,
        args.status,
        args.parentRunId,
      ],
    );

    return runId;
  }

  it("cascades the run-tree when a flow orchestrator is stopped (children Abandoned, orchestrator → Review)", async () => {
    const projectId = await seedProject();
    const flowId = await seedFlow(projectId);
    const orchTaskId = randomUUID();
    const orchestratorRunId = randomUUID();

    await pool.query(
      `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "launch_mode")
       VALUES ($1, $2, 1, 'orc', 'coordinate', 'manual')`,
      [orchTaskId, projectId],
    );
    // A Running flow orchestrator (stoppable) with children; acp_session_id is
    // NULL so no supervisor call is attempted.
    await pool.query(
      `INSERT INTO "runs" ("id", "run_kind", "project_id", "task_id", "flow_id",
         "status", "current_step_id", "acp_session_id", "flow_version", "flow_revision", "root_run_id")
       VALUES ($1, 'flow', $2, $3, $4, 'Running', 'coordinate', NULL, 'v1.0.0', 'unknown', $1)`,
      [orchestratorRunId, projectId, orchTaskId, flowId],
    );

    const runningChild = await seedAgentChild({
      projectId,
      flowId,
      parentRunId: orchestratorRunId,
      status: "Running",
    });
    const needsInputChild = await seedAgentChild({
      projectId,
      flowId,
      parentRunId: orchestratorRunId,
      status: "NeedsInput",
    });

    const result = await stopWorkbenchRun(orchestratorRunId);

    expect(result).toMatchObject({ ok: true, runStatus: "Review" });

    const rows = await pool.query(
      `SELECT "id", "status" FROM "runs" WHERE "id" = ANY($1)`,
      [[orchestratorRunId, runningChild, needsInputChild]],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r.status]));

    expect(byId.get(orchestratorRunId)).toBe("Review");
    expect(byId.get(runningChild)).toBe("Abandoned");
    expect(byId.get(needsInputChild)).toBe("Abandoned");
  });
});
