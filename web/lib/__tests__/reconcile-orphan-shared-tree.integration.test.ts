// F3 part 2 (ADR-102): reconcile recovery for an ORPHAN shared tree. A crash
// between addWorktree (git) and the workspaces insert can leave a shared tree
// with runs but NO workspaces row, while the deterministic path exists on disk.
// recoverOrphanSharedTrees re-creates the missing row (owned by the EARLIEST
// shared child, base_commit=null) so promote/diff/GC can resolve the tree.
//
// The supervisor + git are injected (listWorktrees returns the deterministic
// path); the DB is real (the group-by + insert is what's exercised).
//
// RED before the recovery pass: the tree stays with ZERO workspaces rows.

import type { WorktreeInfo } from "@/lib/worktree";

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

let recoverOrphanSharedTrees: typeof import("@/lib/reconcile").recoverOrphanSharedTrees;
let sharedAgentWorktreePath: typeof import("@/lib/agents/launch").sharedAgentWorktreePath;

let projectId: string;
let projectSlug: string;
let repoPath: string;
let executorId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("reconcile_orphan_tree_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ recoverOrphanSharedTrees } = await import("@/lib/reconcile"));
  ({ sharedAgentWorktreePath } = await import("@/lib/agents/launch"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "workspaces"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  projectSlug = `recon-orphan-${projectId.slice(0, 8)}`;
  repoPath = `/repos/orphan-${projectId}`;
  executorId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      projectSlug,
      repoPath,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );

  await (db as any)
    .insert((await import("@/lib/db/schema")).platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  await pool.query(
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ('test-pkg:worker', 'test-pkg', 'v1.0.0', 'git', 'worker', 'd', 'worktree', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/worker.md', true)
     ON CONFLICT (id) DO NOTHING`,
  );
});

// M42 (ADR-114): the runner mirror moved off `runs` to the run's `default`
// `run_sessions` row.
async function seedDefaultRunSession(runId: string): Promise<void> {
  await pool.query(
    `INSERT INTO "run_sessions" ("id", "run_id", "session_name", "runner_id", "capability_agent", "runner_snapshot")
     VALUES ($1, $2, 'default', $3, 'claude', '{"capabilityAgent":"claude"}'::jsonb)`,
    [randomUUID(), runId, executorId],
  );
}

async function seedRoot(): Promise<string> {
  const id = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "status", "flow_version", "flow_revision", "root_run_id")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, 'WaitingOnChildren', 'agent', 'manual', $1)`,
    [id, projectId],
  );
  await seedDefaultRunSession(id);

  return id;
}

// A shared child of the tree (no workspaces row). startedAt orders the
// earliest-child selection.
async function seedSharedChild(args: {
  rootRunId: string;
  startedAt: string;
  status?: string;
}): Promise<string> {
  const id = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id", "status",
       "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "agent_workspace", "workspace_mode", "started_at")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, $3, 'agent', 'manual', $4, $4,
             'worktree', 'shared', $5)`,
    [id, projectId, args.status ?? "Review", args.rootRunId, args.startedAt],
  );
  await seedDefaultRunSession(id);

  return id;
}

async function workspaceRowsForRoot(rootRunId: string): Promise<
  Array<{
    run_id: string;
    branch: string;
    worktree_path: string;
    base_commit: string | null;
  }>
> {
  const r = await pool.query(
    `SELECT w."run_id", w."branch", w."worktree_path", w."base_commit"
       FROM "workspaces" w
       JOIN "runs" r ON r."id" = w."run_id"
      WHERE r."root_run_id" = $1`,
    [rootRunId],
  );

  return r.rows;
}

describe("F3 (ADR-102) — reconcile recovers an orphan shared tree (path on disk, no workspaces row)", () => {
  it("inserts a synthetic workspaces row owned by the EARLIEST shared child when the deterministic path exists on disk", async () => {
    const root = await seedRoot();
    const sharedPath = sharedAgentWorktreePath(projectSlug, root);

    // Two shared children, no workspaces row. The earliest (by started_at) owns
    // the synthetic row.
    const earliest = await seedSharedChild({
      rootRunId: root,
      startedAt: "2026-01-01T00:00:00Z",
    });

    await seedSharedChild({
      rootRunId: root,
      startedAt: "2026-01-02T00:00:00Z",
    });

    expect(await workspaceRowsForRoot(root)).toHaveLength(0);

    // The deterministic path is on disk (the crashed allocator's worktree).
    const listWorktrees = async (_repo: string): Promise<WorktreeInfo[]> => [
      {
        path: sharedPath,
        branch: `maister/agents/${root}`,
        head: "deadbeef",
        bare: false,
        locked: false,
        prunable: false,
      },
    ];

    await recoverOrphanSharedTrees({ db, listWorktrees });

    const rows = await workspaceRowsForRoot(root);

    expect(rows).toHaveLength(1);
    expect(rows[0].run_id).toBe(earliest);
    expect(rows[0].worktree_path).toBe(sharedPath);
    expect(rows[0].branch).toBe(`maister/agents/${root}`);
    // The true base is lost — promote/diff tolerate null.
    expect(rows[0].base_commit).toBeNull();
  });

  it("does NOT create a row when the deterministic path is absent on disk (genuinely gone, nothing to recover)", async () => {
    const root = await seedRoot();

    await seedSharedChild({
      rootRunId: root,
      startedAt: "2026-01-01T00:00:00Z",
    });

    // No worktrees on disk.
    const listWorktrees = async (_repo: string): Promise<WorktreeInfo[]> => [];

    await recoverOrphanSharedTrees({ db, listWorktrees });

    expect(await workspaceRowsForRoot(root)).toHaveLength(0);
  });

  it("does NOT create a second row when the tree already has a workspaces row (idempotent)", async () => {
    const root = await seedRoot();
    const sharedPath = sharedAgentWorktreePath(projectSlug, root);
    const child = await seedSharedChild({
      rootRunId: root,
      startedAt: "2026-01-01T00:00:00Z",
    });

    // The allocator's row already exists.
    await pool.query(
      `INSERT INTO "workspaces" ("id", "run_id", "project_id", "branch", "worktree_path", "parent_repo_path",
         "base_commit", "base_branch", "target_branch", "promotion_mode", "promotion_state")
       VALUES ($1, $2, $3, $4, $5, $6, 'base000', 'main', 'main', 'local_merge', 'none')`,
      [
        randomUUID(),
        child,
        projectId,
        `maister/agents/${root}`,
        sharedPath,
        repoPath,
      ],
    );

    const listWorktrees = async (_repo: string): Promise<WorktreeInfo[]> => [
      {
        path: sharedPath,
        branch: `maister/agents/${root}`,
        head: "deadbeef",
        bare: false,
        locked: false,
        prunable: false,
      },
    ];

    await recoverOrphanSharedTrees({ db, listWorktrees });

    expect(await workspaceRowsForRoot(root)).toHaveLength(1);
  });
});
