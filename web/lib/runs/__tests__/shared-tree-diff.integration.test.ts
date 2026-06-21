// T12 (Phase 2, ADR-101): a reviewable diff for a REUSER shared child resolves
// the TREE workspace, not the child's own (absent) workspaces row.
//
// A shared writable tree is ONE git worktree = ONE branch = ONE cumulative diff
// owned by the ALLOCATOR child's `workspaces` row; the REUSER children of the
// same orchestrator tree (root_run_id) carry NO row of their own. The two diff
// READ sites must therefore tree-resolve by (root_run_id, workspace_mode=
// 'shared') for a reuser child:
//   1. GET /api/runs/[runId]/diff  (loadFlowDiffRows workspace lookup)
//   2. lib/review-comments/run-diff-source.ts → computeRunDiff (the gate-diff
//      source the review-comment routes + the run-detail gate panel render).
//
// Both run against a REAL Postgres testcontainer + a REAL git repo so the
// `workspaces.run_id = <reuserChild>` predicate genuinely yields zero rows. The
// git diff side-effect is real (a small committed change); nothing about the
// parser is stubbed.
//
// RED today: BOTH read sites query `workspaces WHERE run_id = run.id`. For a
// reuser child that returns no row → MaisterError PRECONDITION "workspace not
// found: <reuserChildRunId>" before any diff is produced. The tree-resolve is
// Phase 2.

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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

import { testPlatformRunnerRow } from "@/lib/__tests__/runner-fixtures";
import { isMaisterError } from "@/lib/errors";

const execFileAsync = promisify(execFile);

// Both read sites resolve the db through getDb(): the route always, and
// run-diff-source for getReviewGateThreadCounts. computeRunDiff takes an
// explicit db, but pointing the client at the same testcontainer keeps every
// path on one DB.
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", () => ({
  requireActiveSession: vi.fn(async () => undefined),
  requireProjectAction: vi.fn(async () => undefined),
}));

let container: StartedPostgreSqlContainer;
let pool: Pool;

const createdPaths: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });

  return stdout;
}

let projectId: string;
let executorId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("shared_tree_diff_test")
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
  for (const p of createdPaths.splice(0)) {
    await rm(p, { recursive: true, force: true });
  }
});

beforeEach(async () => {
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

  await pool.query(
    `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ('test-pkg:worker', 'test-pkg', 'v1.0.0', 'git', 'worker', 'd', 'worktree', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/worker.md', true)
     ON CONFLICT (id) DO NOTHING`,
  );
});

type Fixture = {
  repo: string;
  worktree: string;
  branch: string;
  baseSha: string;
};

// A real parent repo + a shared-tree worktree on `maister/agents/<root>` with a
// committed change (so base..branch produces a NON-empty diff).
async function buildSharedTree(rootRunId: string): Promise<Fixture> {
  const repo = await mkdtemp(join(tmpdir(), "maister-stdiff-parent-"));
  const wtRoot = await mkdtemp(join(tmpdir(), "maister-stdiff-wt-"));

  createdPaths.push(repo, wtRoot);

  const branch = `maister/agents/${rootRunId}`;
  const worktree = join(wtRoot, rootRunId);

  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@maister.local");
  await git(repo, "config", "user.name", "MAIster Test");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  const baseSha = (await git(repo, "rev-parse", "HEAD")).trim();

  await git(repo, "worktree", "add", "-q", "-b", branch, worktree, "HEAD");
  await writeFile(join(worktree, "shared-change.txt"), "tree-work\n");
  await git(worktree, "add", "-A");
  await git(worktree, "commit", "-q", "-m", "shared tree change");

  return { repo, worktree, branch, baseSha };
}

async function seedRoot(): Promise<string> {
  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "project_id",
       "status", "flow_version", "flow_revision", "root_run_id", "runner_id")
     VALUES ($1, 'agent', 'test-pkg:worker', $2, 'Running', 'agent', 'manual', $1, $3)`,
    [runId, projectId, executorId],
  );

  return runId;
}

// A shared child in Review. `withWorkspace` selects the allocator (owns the one
// tree workspaces row pointing at `fx`) vs a reuser (no row of its own).
async function seedSharedChild(args: {
  rootRunId: string;
  withWorkspace: boolean;
  fx?: Fixture;
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

  if (args.withWorkspace && args.fx) {
    await pool.query(
      `INSERT INTO "workspaces" ("id", "run_id", "project_id", "branch", "worktree_path", "parent_repo_path",
         "base_commit", "base_branch", "target_branch", "promotion_mode", "promotion_state")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'main', 'main', 'local_merge', 'none')`,
      [
        randomUUID(),
        childRunId,
        projectId,
        args.fx.branch,
        args.fx.worktree,
        args.fx.repo,
        args.fx.baseSha,
      ],
    );
  }

  return childRunId;
}

async function getDiff(runId: string): Promise<Response> {
  const { GET } = await import("@/app/api/runs/[runId]/diff/route");

  return GET(new Request(`http://x/api/runs/${runId}/diff`), {
    params: Promise.resolve({ runId }),
  } as never);
}

describe("ADR-101 T12 — reviewable diff resolves the TREE workspace for a reuser shared child", () => {
  it("GET /api/runs/[runId]/diff for a reuser shared child resolves the shared tree diff (not 'workspace not found')", async () => {
    const root = await seedRoot();
    const fx = await buildSharedTree(root);

    // Allocator owns the tree workspace; the reuser child has none.
    await seedSharedChild({ rootRunId: root, withWorkspace: true, fx });
    const reuserChild = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });

    const res = await getDiff(reuserChild);

    // RED today: 409 PRECONDITION "workspace not found: <reuserChild>".
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;

    // The shared tree diff — NOT empty, NOT the child's own (absent) workspace.
    expect(body.baseCommit).toBe(fx.baseSha);
    expect(body.sourceBranch).toBe(fx.branch);
    expect(body.diff).toContain("shared-change.txt");
  });

  it("run-diff-source.computeRunDiff for a reuser shared child resolves the shared tree diff (no PRECONDITION)", async () => {
    const root = await seedRoot();
    const fx = await buildSharedTree(root);

    await seedSharedChild({ rootRunId: root, withWorkspace: true, fx });
    const reuserChild = await seedSharedChild({
      rootRunId: root,
      withWorkspace: false,
    });

    const { computeRunDiff } = await import(
      "@/lib/review-comments/run-diff-source"
    );

    let thrown: unknown;
    let prepared: Awaited<ReturnType<typeof computeRunDiff>> | undefined;

    try {
      prepared = await computeRunDiff(db, {
        id: reuserChild,
        projectId,
      });
    } catch (err) {
      thrown = err;
    }

    // RED today: PRECONDITION "workspace not found: <reuserChild>".
    const isWorkspaceNotFound =
      isMaisterError(thrown) &&
      thrown.code === "PRECONDITION" &&
      /workspace not found/i.test(thrown.message);

    expect(isWorkspaceNotFound).toBe(false);
    expect(thrown).toBeUndefined();

    // The shared tree diff is produced (the committed change appears).
    const files = prepared?.files ?? [];

    expect(files.some((f) => f.path === "shared-change.txt")).toBe(true);
  });
});
