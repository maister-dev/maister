// T16 (Phase 2, ADR-101): workspace GC must be SHARED-TREE-aware.
//
// A shared writable tree is ONE git worktree owned by the ALLOCATOR child's
// `workspaces` row; the REUSER siblings of the same orchestrator tree
// (root_run_id) carry NO row of their own but still operate IN that one
// worktree. So the worktree may only be collected once EVERY shared sibling is
// terminal — collecting it while a reuser sibling is still Running/Review would
// pull the directory out from under a live agent.
//
// Contract:
//   - an Abandoned/Done ALLOCATOR whose shared sibling (same root_run_id) is
//     still NON-terminal (Running/Review) is NOT collected (worktree preserved).
//   - once ALL shared siblings are terminal (Done|Failed|Crashed|Abandoned),
//     the workspace IS collected.
//
// RED today: loadCandidates joins workspaces ⨝ runs ON runs.id =
// workspaces.run_id and gates only on the ALLOCATOR run's status — it never
// inspects sibling runs sharing root_run_id. So a terminal allocator with a live
// reuser sibling is (wrongly) collected. The tree-aware exclusion is Phase 2.

import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
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

import * as schemaModule from "@/lib/db/schema";
import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { runWorkspaceGcSweep } from "@/lib/gc/workspace-gc";

const schema = schemaModule as unknown as Record<string, any>;
const { workspaces } = schema;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

let projectId: string;
let projectRepoPath: string;
let executorId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("shared_tree_gc_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "workspaces"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "platform_acp_runners"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  projectRepoPath = `/repos/stgc-${randomUUID()}`;
  executorId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 1)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      projectRepoPath,
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
    `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ('test-pkg:worker', 'test-pkg', 'v1.0.0', 'git', 'worker', 'd', 'worktree', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/worker.md', true)
     ON CONFLICT (id) DO NOTHING`,
  );
});

// The orchestrator tree root.
async function seedRoot(): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "root_run_id", "runner_id")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, 'Done', 'agent', 'manual', $1, $3)`,
    [runId, projectId, executorId],
  );

  return runId;
}

// The ALLOCATOR child (owns the one tree workspaces row) — terminal + past its
// GC deadline. Returns { runId, workspaceId, worktreePath }.
async function seedAllocator(args: {
  rootRunId: string;
  status?: string;
}): Promise<{ runId: string; workspaceId: string; worktreePath: string }> {
  const runId = randomUUID();
  const workspaceId = randomUUID();
  const worktreePath = `/worktrees/stgc-${args.rootRunId}`;

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "launch_mode", "agent_workspace", "workspace_mode", "runner_snapshot", "runner_id", "ended_at")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, $3, 'agent', 'manual', $4, $4,
             'manual', 'worktree', 'shared', '{"capabilityAgent":"claude"}'::jsonb, $5, now())`,
    [runId, projectId, args.status ?? "Abandoned", args.rootRunId, executorId],
  );

  await pool.query(
    `INSERT INTO "workspaces" ("id", "run_id", "project_id", "branch", "worktree_path", "parent_repo_path",
       "scheduled_removal_at")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      workspaceId,
      runId,
      projectId,
      `maister/agents/${args.rootRunId}`,
      worktreePath,
      projectRepoPath,
      new Date(Date.now() - 86_400_000), // past deadline
    ],
  );

  return { runId, workspaceId, worktreePath };
}

// A REUSER sibling of the tree (same root_run_id), NO workspaces row.
async function seedSibling(args: {
  rootRunId: string;
  status: string;
}): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "launch_mode", "agent_workspace", "workspace_mode", "runner_snapshot", "runner_id", "ended_at")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, $3, 'agent', 'manual', $4, $4,
             'manual', 'worktree', 'shared', '{"capabilityAgent":"claude"}'::jsonb, $5, $6)`,
    [
      runId,
      projectId,
      args.status,
      args.rootRunId,
      executorId,
      // Terminal siblings get an ended_at; live ones leave it null.
      ["Done", "Failed", "Crashed", "Abandoned"].includes(args.status)
        ? new Date()
        : null,
    ],
  );

  return runId;
}

async function readWorkspace(workspaceId: string): Promise<any> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  return rows[0];
}

// Inject successful preserve + spies (the orchestration ran-or-not is what we
// assert) and force worktreeExists=true so the preserve→remove path runs when a
// row IS a candidate (synthetic paths never exist on disk).
function makeOpts() {
  const removeOwnedWorktree = vi.fn(
    async (_args: Record<string, unknown>) => {},
  );
  const resolveBaseRef = vi.fn(async () => "basesha000000000000000000000");
  const preserveWorktree = vi.fn(async (a: { runId: string }) => ({
    ok: true,
    archivedBranch: `maister/archive/${a.runId}`,
    archivedAt: new Date(),
    snapshotted: true,
  }));
  const worktreeExists = vi.fn(async () => true);
  const deleteRunCheckpointRefs = vi.fn(async () => 0);

  return {
    opts: {
      db,
      now: () => new Date(),
      preserveWorktree,
      removeOwnedWorktree,
      resolveBaseRef,
      worktreeExists,
      deleteRunCheckpointRefs,
    },
    removeOwnedWorktree,
    preserveWorktree,
  };
}

describe("ADR-101 T16 — workspace GC is shared-tree-aware", () => {
  for (const liveStatus of ["Running", "Review"]) {
    it(`does NOT collect a terminal allocator while a shared sibling is still ${liveStatus}`, async () => {
      const root = await seedRoot();
      const { workspaceId } = await seedAllocator({
        rootRunId: root,
        status: "Abandoned",
      });

      // A shared sibling of the SAME tree is still non-terminal.
      await seedSibling({ rootRunId: root, status: liveStatus });

      const { opts, removeOwnedWorktree, preserveWorktree } = makeOpts();
      const summary = await runWorkspaceGcSweep(opts);

      // The shared worktree is preserved: the row is NOT a candidate.
      expect(summary.pruned).toBe(0);
      expect(preserveWorktree).not.toHaveBeenCalled();
      expect(removeOwnedWorktree).not.toHaveBeenCalled();
      expect((await readWorkspace(workspaceId)).removedAt).toBeNull();
    }, 60_000);
  }

  it("DOES collect once ALL shared siblings are terminal", async () => {
    const root = await seedRoot();
    const { workspaceId } = await seedAllocator({
      rootRunId: root,
      status: "Abandoned",
    });

    // Every shared sibling is terminal now.
    await seedSibling({ rootRunId: root, status: "Done" });
    await seedSibling({ rootRunId: root, status: "Failed" });

    const { opts, removeOwnedWorktree } = makeOpts();
    const summary = await runWorkspaceGcSweep(opts);

    expect(summary.pruned).toBeGreaterThanOrEqual(1);
    expect(removeOwnedWorktree).toHaveBeenCalledTimes(1);
    expect((await readWorkspace(workspaceId)).removedAt).not.toBeNull();
  }, 60_000);
});
