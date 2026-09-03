// ADR-156 D7: the chain-depth refusal must leave NOTHING behind.
//
// The gate is a pure DB read, but it used to run AFTER `addWorktree`, so an
// at-cap `worktree`-mode launch threw with a directory and a branch ref already
// allocated and no `runs`/`workspaces` row for GC to key on — repeated refusals
// accumulated disk and pre-claimed the next launch's path/branch. The refusal
// itself is only half the behavior under test here; the ABSENCE of the git
// side-effects is the other half.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const exec = promisify(execFile);

// A refusal must never reach the scheduler; if it did, this stub is what proves
// the launch got further than it should have.
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let cacheRoot: string;
let worktreesTmp: string;
let originalWorktreesRoot: string | undefined;
let originalCap: string | undefined;

let launchAgentRun: typeof import("@/lib/agents/launch").launchAgentRun;
let agentWorkdirPath: typeof import("@/lib/agents/launch").agentWorkdirPath;
let agentWorktreeBranchName: typeof import("@/lib/agents/launch").agentWorktreeBranchName;

let projectId: string;
let projectSlug: string;
let repoPath: string;

beforeAll(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "maister-chaincap-cache-"));

  testDatabase = await startMainPostgresTestDb({
    databaseName: "chain_cap_side_effects_test",
  });

  pool = testDatabase.pool;
  db = testDatabase.db;
  // ADR-166: every launch places the run on the local execution host.
  await fakeExecutionHosts(db);

  ({ launchAgentRun, agentWorkdirPath, agentWorktreeBranchName } = await import(
    "@/lib/agents/launch"
  ));
}, 240_000);

afterAll(async () => {
  await testDatabase?.stop();
  await rm(cacheRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Worktrees stay under $HOME: a macOS /tmp symlink breaks path identity for
  // `git worktree list` comparisons.
  worktreesTmp = await mkdtemp(
    path.join(os.homedir(), ".maister-chaincap-wt-"),
  );
  originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
  process.env.MAISTER_WORKTREES_ROOT = worktreesTmp;
  originalCap = process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH;

  repoPath = await mkdtemp(path.join(os.homedir(), ".maister-chaincap-repo-"));
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

  await pool.query(`DELETE FROM "workspaces"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "project_package_attachments"`);
  await pool.query(`DELETE FROM "package_installs"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
  await pool.query(`DELETE FROM "projects"`);

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

  const runnerId = randomUUID();

  await (db as any)
    .insert((await import("@/lib/db/schema")).platformAcpRunners)
    .values(testPlatformRunnerRow(runnerId, "claude"));
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', $1)
     ON CONFLICT (id) DO UPDATE SET "default_runner_id" = $1`,
    [runnerId],
  );
});

afterEach(async () => {
  if (originalWorktreesRoot === undefined) {
    delete process.env.MAISTER_WORKTREES_ROOT;
  } else {
    process.env.MAISTER_WORKTREES_ROOT = originalWorktreesRoot;
  }
  if (originalCap === undefined) {
    delete process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH;
  } else {
    process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH = originalCap;
  }
  await rm(worktreesTmp, { recursive: true, force: true });
  await rm(repoPath, { recursive: true, force: true });
});

// One `worktree`-mode agent shipped by one attached, trusted, Installed package
// — the shape the effective-definition resolver walks at launch.
async function seedWorktreeAgent(stem: string): Promise<string> {
  const revisionId = randomUUID();
  const installedPath = path.join(cacheRoot, `pkg-${revisionId.slice(0, 8)}`);

  await mkdir(path.join(installedPath, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(installedPath, "maister-agents", `${stem}.md`),
    `---
name: ${stem}
description: d
workspace: worktree
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

  const packageInstallId = randomUUID();

  await pool.query(
    `INSERT INTO "package_installs"
       ("id", "source_url", "name", "version_label", "resolved_revision",
        "manifest", "manifest_digest", "installed_path", "package_status", "trust_status")
     VALUES ($1, 'github.com/acme/test-pkg', 'test-pkg', 'v1.0.0', $2,
             '{}'::jsonb, 'digest', $3, 'Installed', 'trusted')`,
    [packageInstallId, `rev-${revisionId.slice(0, 8)}`, installedPath],
  );
  await pool.query(
    `INSERT INTO "project_package_attachments"
       ("id", "project_id", "package_install_id", "package_name")
     VALUES ($1, $2, $3, 'test-pkg')`,
    [randomUUID(), projectId, packageInstallId],
  );

  const agentId = `test-pkg:${stem}`;

  await pool.query(
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, 'test-pkg', 'v1.0.0', 'git', $2, 'd', 'worktree', 'session', '["manual"]'::jsonb, 'read_only', $3, true)`,
    [agentId, stem, path.join(installedPath, "maister-agents", `${stem}.md`)],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
    [randomUUID(), agentId, projectId],
  );

  return agentId;
}

async function branchRefs(): Promise<string[]> {
  const { stdout } = await exec("git", [
    "-C",
    repoPath,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);

  return stdout.split("\n").filter((line) => line.trim() !== "");
}

async function pathExists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

describe("ADR-156 D7 — an at-cap refusal allocates nothing", () => {
  // cap 0 is the operator setting that forbids agent-triggered chains outright,
  // and `resolveAgentChainDepth` reports atCap for EVERY trigger source under
  // it — the shortest deterministic at-cap launch there is.
  it("refuses PRECONDITION and leaves no worktree dir, no branch ref, and no rows", async () => {
    const agentId = await seedWorktreeAgent("capped");

    process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH = "0";

    const runId = randomUUID();
    const expectedWorktree = agentWorkdirPath(projectSlug, runId);
    const expectedBranch = agentWorktreeBranchName({
      prefix: "maister/",
      agentId,
      runId,
    });

    await expect(
      launchAgentRun({
        agentId,
        projectId,
        runId,
        workspace: "worktree",
        trigger: { source: "manual" },
        db,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "PRECONDITION",
    );

    // The point of the test: the refusal is a NO-OP on disk and in git. A leaked
    // dir/branch has no run row, so nothing ever collects it and the next launch
    // of the same run id collides on both.
    expect(await pathExists(expectedWorktree)).toBe(false);
    expect(await branchRefs()).toEqual(["main"]);
    expect(await branchRefs()).not.toContain(expectedBranch);

    const { listWorktrees } = await import("@/lib/worktree");

    expect(await listWorktrees(repoPath)).toHaveLength(1);

    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM "runs"`)).rows[0].n,
    ).toBe(0);
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM "workspaces"`)).rows[0]
        .n,
    ).toBe(0);
  }, 120_000);

  // The refusal must not become a launch blocker at the same time: with budget
  // left, the identical launch still allocates its worktree and run row.
  it("allocates normally when the chain budget has room", async () => {
    const agentId = await seedWorktreeAgent("uncapped");

    process.env.MAISTER_MAX_AGENT_CHAIN_DEPTH = "2";

    const result = await launchAgentRun({
      agentId,
      projectId,
      workspace: "worktree",
      trigger: { source: "manual" },
      db,
    });

    if ("deduped" in result) throw new Error("unexpected dedup");

    expect(await pathExists(agentWorkdirPath(projectSlug, result.runId))).toBe(
      true,
    );

    const rows = await pool.query(
      `SELECT "agent_chain_depth" FROM "runs" WHERE "id" = $1`,
      [result.runId],
    );

    expect(rows.rows[0].agent_chain_depth).toBe(0);
  }, 120_000);
});
