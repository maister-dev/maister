// M37 Phase 10/11 (ADR-099): worktree allocation modes (own | shared) and the
// reviewer read-only reuse, exercised end-to-end through launchAgentRun against
// a real git repo. tryStartRun is stubbed so no supervisor session spawns — the
// assertions are on the worktree/branch allocation and the persisted run row.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

const exec = promisify(execFile);

vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let cacheRoot: string;
let worktreesTmp: string;
let originalWorktreesRoot: string | undefined;

let launchAgentRun: typeof import("@/lib/agents/launch").launchAgentRun;
let sharedAgentWorktreePath: typeof import("@/lib/agents/launch").sharedAgentWorktreePath;

beforeAll(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "maister-lwm-cache-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ launchAgentRun, sharedAgentWorktreePath } = await import(
    "@/lib/agents/launch"
  ));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
  await rm(cacheRoot, { recursive: true, force: true });
});

let projectId: string;
let projectSlug: string;
let executorId: string;
let repoPath: string;

beforeEach(async () => {
  worktreesTmp = await mkdtemp(path.join(os.homedir(), ".maister-lwm-wt-"));
  originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
  process.env.MAISTER_WORKTREES_ROOT = worktreesTmp;

  await pool.query(`DELETE FROM "workspaces"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
  await pool.query(`DELETE FROM "projects"`);

  // A real git repo for worktree allocation.
  repoPath = await mkdtemp(path.join(os.homedir(), ".maister-lwm-repo-"));
  await exec("git", ["-C", repoPath, "init", "-q", "-b", "main"]);
  await writeFile(path.join(repoPath, "README.md"), "hello\n");
  await exec("git", ["-C", repoPath, "add", "-A"]);
  await exec("git", [
    "-C",
    repoPath,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init",
  ]);

  projectId = randomUUID();
  projectSlug = `p-${projectId.slice(0, 8)}`;
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
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = $1`,
    [executorId],
  );
});

afterEach(async () => {
  if (originalWorktreesRoot === undefined) {
    delete process.env.MAISTER_WORKTREES_ROOT;
  } else {
    process.env.MAISTER_WORKTREES_ROOT = originalWorktreesRoot;
  }
  await rm(worktreesTmp, { recursive: true, force: true });
  await rm(repoPath, { recursive: true, force: true });
});

// Install one package revision (the agents/<stem>.md is resolved by the
// effective-definition resolver from installed_path) + an enabled trusted flow,
// and register every agent in the catalog index + attach it to the project.
async function seedPackageWithAgents(
  agents: Array<{ stem: string; workspace: "none" | "repo_read" | "worktree" }>,
): Promise<Record<string, string>> {
  const revisionId = randomUUID();
  const installedPath = path.join(cacheRoot, `pkg-${revisionId.slice(0, 8)}`);

  await mkdir(path.join(installedPath, "maister-agents"), { recursive: true });

  const ids: Record<string, string> = {};

  for (const a of agents) {
    await writeFile(
      path.join(installedPath, "maister-agents", `${a.stem}.md`),
      `---
name: ${a.stem}
description: d
workspace: ${a.workspace}
mode: session
triggers:
  - manual
risk_tier: read_only
---
Do the thing.
`,
      "utf8",
    );
  }

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path", "package_status")
     VALUES ($1, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', 'rev-1',
             'digest', '{}'::jsonb, 1, $2, 'Installed')`,
    [revisionId, installedPath],
  );
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', $3,
             '{}'::jsonb, 1, $4, 'Enabled', 'trusted', 'pinned')`,
    [randomUUID(), projectId, installedPath, revisionId],
  );

  for (const a of agents) {
    const qualifiedId = `test-pkg:${a.stem}`;

    ids[a.stem] = qualifiedId;
    await pool.query(
      `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
       VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', $3, 'session', '["manual"]'::jsonb, 'read_only', $4, true)`,
      [
        qualifiedId,
        a.stem,
        a.workspace,
        path.join(installedPath, "maister-agents", `${a.stem}.md`),
      ],
    );
    await pool.query(
      `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
      [randomUUID(), qualifiedId, projectId],
    );
  }

  return ids;
}

// A root orchestrator run for the delegation tree.
async function insertRoot(): Promise<string> {
  const id = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "trigger_source", "project_id", "flow_version", "flow_revision", "status", "root_run_id", "runner_id")
     VALUES ($1, 'agent', $2, 'manual', $3, 'agent', 'manual', 'WaitingOnChildren', $1, $4)`,
    [id, "test-pkg:coordinator", projectId, executorId],
  );

  return id;
}

async function runRow(
  id: string,
): Promise<{ workspace_mode: string | null; agent_workspace: string | null }> {
  const res = await pool.query(
    `SELECT "workspace_mode", "agent_workspace" FROM "runs" WHERE "id" = $1`,
    [id],
  );

  return res.rows[0];
}

async function workspaceRows(
  worktreePath: string,
): Promise<Array<{ run_id: string; branch: string }>> {
  const res = await pool.query(
    `SELECT "run_id", "branch" FROM "workspaces" WHERE "worktree_path" = $1`,
    [worktreePath],
  );

  return res.rows;
}

describe("M37 Phase 10 — worktree allocation modes via launchAgentRun", () => {
  it("two shared-mode children of one root resolve to the SAME tree (2nd reuses, no duplicate workspaces row)", async () => {
    const ids = await seedPackageWithAgents([
      { stem: "coordinator", workspace: "worktree" },
      { stem: "worker", workspace: "worktree" },
    ]);
    const root = await insertRoot();
    const sharedPath = sharedAgentWorktreePath(projectSlug, root);
    const sharedBranch = `maister/agents/${root}`;

    const first = await launchAgentRun({
      agentId: ids.worker,
      projectId,
      parentRunId: root,
      rootRunId: root,
      launchMode: "manual",
      workspaceMode: "shared",
      trigger: { source: "manual" },
      db,
    });
    const second = await launchAgentRun({
      agentId: ids.worker,
      projectId,
      parentRunId: root,
      rootRunId: root,
      launchMode: "manual",
      workspaceMode: "shared",
      trigger: { source: "manual" },
      db,
    });

    if ("deduped" in first || "deduped" in second) {
      throw new Error("delegated launch unexpectedly deduped");
    }

    // Both children carry workspace_mode='shared'.
    expect((await runRow(first.runId)).workspace_mode).toBe("shared");
    expect((await runRow(second.runId)).workspace_mode).toBe("shared");

    // Exactly ONE workspaces row owns the shared tree (worktree_path is UNIQUE);
    // the allocator owns it, the reusing sibling has none.
    const wsRows = await workspaceRows(sharedPath);

    expect(wsRows).toHaveLength(1);
    expect(wsRows[0].run_id).toBe(first.runId);
    expect(wsRows[0].branch).toBe(sharedBranch);

    // The shared worktree exists exactly once in the git registry.
    const { listWorktrees } = await import("@/lib/worktree");
    const trees = await listWorktrees(repoPath);

    expect(trees.filter((w) => w.path === sharedPath)).toHaveLength(1);
  });

  // C4 (real two-racer): two shared-mode children allocating CONCURRENTLY can
  // both pass the listWorktrees check before either addWorktree completes (the
  // TOCTOU /aif-review flagged). The idempotent allocation (catch → re-check →
  // reuse, else typed CONFLICT) must converge to exactly ONE tree + ONE
  // workspaces row, and NEVER surface a raw git error as a 500.
  it("(C4) two CONCURRENT shared-mode allocations converge to one tree (no raw 500)", async () => {
    const ids = await seedPackageWithAgents([
      { stem: "coordinator", workspace: "worktree" },
      { stem: "worker", workspace: "worktree" },
    ]);
    const root = await insertRoot();
    const sharedPath = sharedAgentWorktreePath(projectSlug, root);

    const launch = () =>
      launchAgentRun({
        agentId: ids.worker,
        projectId,
        parentRunId: root,
        rootRunId: root,
        launchMode: "manual",
        workspaceMode: "shared",
        trigger: { source: "manual" },
        db,
      });

    const results = await Promise.allSettled([launch(), launch()]);

    // At least one allocation succeeded; any rejection is a TYPED CONFLICT (the
    // idempotent-allocation guard), never an untyped raw git failure.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of results) {
      if (r.status === "rejected") {
        expect((r.reason as { code?: string }).code).toBe("CONFLICT");
      }
    }

    // Exactly one workspaces row + one git worktree for the shared path.
    expect(await workspaceRows(sharedPath)).toHaveLength(1);
    const { listWorktrees } = await import("@/lib/worktree");
    const trees = await listWorktrees(repoPath);

    expect(trees.filter((w) => w.path === sharedPath)).toHaveLength(1);
  }, 60_000);

  // F3 (ADR-102): the allocator decision is DB-truth, not a bare filesystem
  // observation. A crash between addWorktree (git, outside the tx) and the
  // workspaces insert leaves an ORPHAN path on disk with NO workspaces row. The
  // old code (reuseSharedTree = listWorktrees().some(path)) saw that path and set
  // reuseSharedTree=true → skipped the insert → the tree NEVER got a row (promote/
  // diff/GC could not resolve it). The fix: decide reuse from a DB row; when the
  // path exists but no row does, CLAIM the orphan (insert the row, reuse the dir).
  //
  // RED before the fix: launching a shared child of a root whose path is already
  // on disk (no row) leaves the tree with ZERO workspaces rows.
  it("(F3) a shared worktree path on disk with NO workspaces row is CLAIMED by the next shared child (exactly one row results)", async () => {
    const ids = await seedPackageWithAgents([
      { stem: "coordinator", workspace: "worktree" },
      { stem: "worker", workspace: "worktree" },
    ]);
    const root = await insertRoot();
    const sharedPath = sharedAgentWorktreePath(projectSlug, root);
    const sharedBranch = `maister/agents/${root}`;

    // Simulate the crash window: the git worktree exists on disk (addWorktree
    // ran) but the runs+workspaces tx never committed — NO workspaces row.
    const { addWorktree } = await import("@/lib/worktree");

    await addWorktree({
      projectRepoPath: repoPath,
      worktreePath: sharedPath,
      branch: sharedBranch,
      startPoint: "main",
    });
    expect(await workspaceRows(sharedPath)).toHaveLength(0);

    // The next shared child of the same root CLAIMS the orphan: reuses the dir,
    // inserts the missing workspaces row — never throws.
    const result = await launchAgentRun({
      agentId: ids.worker,
      projectId,
      parentRunId: root,
      rootRunId: root,
      launchMode: "manual",
      workspaceMode: "shared",
      trigger: { source: "manual" },
      db,
    });

    if ("deduped" in result) throw new Error("unexpected dedup");

    // Exactly ONE workspaces row now owns the tree, pointing at the existing dir
    // and owned by the claiming child — so promote/diff/GC can resolve the tree.
    const wsRows = await workspaceRows(sharedPath);

    expect(wsRows).toHaveLength(1);
    expect(wsRows[0].run_id).toBe(result.runId);
    expect(wsRows[0].branch).toBe(sharedBranch);

    // The shared worktree still exists exactly once in the git registry (the
    // claimer reused it, did not re-add).
    const { listWorktrees } = await import("@/lib/worktree");
    const trees = await listWorktrees(repoPath);

    expect(trees.filter((w) => w.path === sharedPath)).toHaveLength(1);

    // The tree is now resolvable for a promote (the resolver keys on the row).
    const { resolveSharedTreeWorkspaceForUpdate } = await import(
      "@/lib/runs/shared-tree"
    );

    await db.transaction(async (tx) => {
      const ws = await resolveSharedTreeWorkspaceForUpdate(tx, {
        rootRunId: root,
      });

      expect(ws.worktreePath).toBe(sharedPath);
    });
  });

  it("an own-mode (default) child gets a per-run worktree and no serialization linkage", async () => {
    const ids = await seedPackageWithAgents([
      { stem: "coordinator", workspace: "worktree" },
      { stem: "worker", workspace: "worktree" },
    ]);
    const root = await insertRoot();
    const sharedPath = sharedAgentWorktreePath(projectSlug, root);

    const result = await launchAgentRun({
      agentId: ids.worker,
      projectId,
      parentRunId: root,
      rootRunId: root,
      launchMode: "manual",
      // no workspaceMode → own
      trigger: { source: "manual" },
      db,
    });

    if ("deduped" in result) throw new Error("unexpected dedup");

    expect((await runRow(result.runId)).workspace_mode).toBeNull();

    // Its workspace row is a per-run path, NOT the shared tree path.
    const perRun = await pool.query(
      `SELECT "worktree_path" FROM "workspaces" WHERE "run_id" = $1`,
      [result.runId],
    );

    expect(perRun.rows[0].worktree_path).not.toBe(sharedPath);
    expect(perRun.rows[0].worktree_path).toContain(result.runId);
  });

  it("workspaceMode=shared with no rootRunId → CONFIG, no run created", async () => {
    const ids = await seedPackageWithAgents([
      { stem: "worker", workspace: "worktree" },
    ]);

    const before = await pool.query(`SELECT count(*)::int AS n FROM "runs"`);

    await expect(
      launchAgentRun({
        agentId: ids.worker,
        projectId,
        // no rootRunId — a top-level run cannot share
        workspaceMode: "shared",
        trigger: { source: "manual" },
        db,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "CONFIG",
    );

    const after = await pool.query(`SELECT count(*)::int AS n FROM "runs"`);

    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("M37 Phase 11 — reviewer read-only child reuses L1/L2/L3", () => {
  it("a workspace:repo_read delegated child records agent_workspace='repo_read' (read-only path engaged)", async () => {
    const ids = await seedPackageWithAgents([
      { stem: "coordinator", workspace: "worktree" },
      { stem: "reviewer", workspace: "repo_read" },
    ]);
    const root = await insertRoot();

    const result = await launchAgentRun({
      agentId: ids.reviewer,
      projectId,
      parentRunId: root,
      rootRunId: root,
      launchMode: "manual",
      trigger: { source: "manual" },
      db,
    });

    if ("deduped" in result) throw new Error("unexpected dedup");

    // The run inherits the agent's repo_read workspace axis — the same column
    // the finalize-time L3 dirty-watchdog gates on (dirty-watchdog.integration
    // proves the quarantine path off this value). No worktree row for repo_read.
    expect((await runRow(result.runId)).agent_workspace).toBe("repo_read");

    const ws = await pool.query(
      `SELECT count(*)::int AS n FROM "workspaces" WHERE "run_id" = $1`,
      [result.runId],
    );

    expect(ws.rows[0].n).toBe(0);
  });
});
