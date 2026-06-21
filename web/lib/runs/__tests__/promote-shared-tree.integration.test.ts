// M37 follow-up (ADR-101): tree-promote on a REUSER shared child. A shared
// writable tree is ONE git worktree = ONE branch = ONE cumulative diff owned by
// the ALLOCATOR child's `workspaces` row; the REUSER children of the same
// orchestrator tree (root_run_id) carry NO workspaces row of their own. A
// run_promote on ANY shared child must resolve the tree workspace by
// (root_run_id, workspace_mode='shared') — NOT by the promoted child's own
// run_id — then merge once. This is the NARROW core assertion (full Review→Done
// settle of ALL shared siblings is Phase 2): calling promoteChildRunForToken on
// a REUSER child must NOT dead-end with PRECONDITION "workspace not found: ...".
//
// RED today: loadWorkspaceForUpdate(tx, reuserChildRunId) (promote.ts) selects
// `workspaces WHERE run_id = reuserChildRunId` → none → throws PRECONDITION
// "workspace not found: <reuserChildRunId>" before any merge.
//
// The git primitives are stubbed (no real repo) so the DB resolution + claim/
// finalize CAS is what's exercised; with the allocator's workspace resolved the
// stubbed local_merge runs and flips the reuser child Done.

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
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { isMaisterError } from "@/lib/errors";

// Git side-effects: a local_merge promote resolves the target tip then merges.
// Both are stubbed (no real repo); the DB claim/finalize CAS stays real.
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

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

let promoteChildRunForToken: typeof import("@/lib/runs/promote").promoteChildRunForToken;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("promote_shared_tree_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ promoteChildRunForToken } = await import("@/lib/runs/promote"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let projectId: string;
let executorId: string;

beforeEach(async () => {
  promoteLocalMergeSpy.mockClear();

  await pool.query(`DELETE FROM "domain_events"`);
  await pool.query(`DELETE FROM "workspaces"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "platform_acp_runners"`);
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
    .insert((await import("@/lib/db/schema")).platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));

  // Minimal agent rows to satisfy runs.agent_id FK (the promote path never
  // dereferences them; the merge resolves the tree workspace, not the agent).
  for (const stem of ["coordinator", "worker"]) {
    await pool.query(
      `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
       VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', 'worktree', 'session', '["manual"]'::jsonb, 'read_only', $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [`test-pkg:${stem}`, stem, `/tmp/${stem}.md`],
    );
  }
});

afterEach(() => {
  vi.clearAllMocks();
});

// An orchestrator parent run (run_kind=agent, its own tree root).
async function seedRoot(): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "root_run_id", "runner_id")
     VALUES ($1, 'agent', 'test-pkg:coordinator', $2, 'Running', 'agent', 'manual', $1, $3)`,
    [runId, projectId, executorId],
  );

  return runId;
}

// A shared-mode delegated child (run_kind=agent, workspace_mode='shared'), in
// Review. `withWorkspace` selects the ALLOCATOR (owns the one shared workspaces
// row) vs a REUSER (no row of its own — the tree workspace is resolved by
// (root_run_id, workspace_mode='shared')).
async function seedSharedChild(args: {
  rootRunId: string;
  withWorkspace: boolean;
}): Promise<string> {
  const childRunId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "parent_run_id", "root_run_id",
       "launch_mode", "agent_workspace", "workspace_mode", "runner_snapshot", "runner_id")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, 'Review', 'agent', 'manual', $3, $3,
             'manual', 'worktree', 'shared', '{"capabilityAgent":"claude"}'::jsonb, $4)`,
    [childRunId, projectId, args.rootRunId, executorId],
  );

  if (args.withWorkspace) {
    // The single shared tree: ONE git worktree = ONE branch, owned by the
    // allocator. worktree_path is UNIQUE, keyed by the tree root.
    await pool.query(
      `INSERT INTO "workspaces" ("id", "run_id", "project_id", "branch", "worktree_path", "parent_repo_path",
         "base_commit", "base_branch", "target_branch", "promotion_mode", "promotion_state")
       VALUES ($1, $2, $3, $4, $5, $6, 'base000', 'main', 'main', 'local_merge', 'none')`,
      [
        randomUUID(),
        childRunId,
        projectId,
        `maister/agents/${args.rootRunId}`,
        `/tmp/shared-wt-${args.rootRunId}`,
        `/repos/${projectId}`,
      ],
    );
  }

  return childRunId;
}

async function runStatus(runId: string): Promise<string | null> {
  const r = await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [
    runId,
  ]);

  return r.rows[0]?.status ?? null;
}

describe("ADR-101 — promoteChildRunForToken resolves the tree workspace for a REUSER shared child", () => {
  it("a REUSER shared child (no workspaces row of its own) does NOT dead-end with PRECONDITION 'workspace not found' — the tree workspace is resolved and the merge runs", async () => {
    const root = await seedRoot();
    // The allocator owns the single shared workspaces row; the reuser has none.
    await seedSharedChild({ rootRunId: root, withWorkspace: true });
    const reuserChildRunId = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });

    let thrown: unknown;

    try {
      await promoteChildRunForToken(reuserChildRunId, {
        projectId,
        actor: { kind: "system" },
        db,
      });
    } catch (err) {
      thrown = err;
    }

    // The narrow contract: the reuser's promote resolved a tree workspace — it
    // did NOT fail with the run_id-scoped "workspace not found" PRECONDITION.
    if (thrown !== undefined) {
      const isWorkspaceNotFound =
        isMaisterError(thrown) &&
        thrown.code === "PRECONDITION" &&
        /workspace not found/i.test(thrown.message);

      expect(isWorkspaceNotFound).toBe(false);
    }

    // With the allocator's workspace resolved, the stubbed local_merge runs and
    // the reuser child reaches Done.
    expect(promoteLocalMergeSpy).toHaveBeenCalledTimes(1);
    expect(await runStatus(reuserChildRunId)).toBe("Done");
  });
});
