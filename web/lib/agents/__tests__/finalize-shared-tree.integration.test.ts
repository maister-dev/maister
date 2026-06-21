// M37 follow-up (ADR-101): a shared WRITABLE worktree is ONE tree = ONE branch =
// ONE cumulative diff shared by N children of one orchestrator tree. The FIRST
// ("allocator") child owns the `workspaces` row (worktree_path is UNIQUE); a
// "reuser" child gets NO row of its own. Every shared writable child must
// finalize to Review (NOT Done) so the tree diff is reviewable/promotable —
// regardless of whether THAT child owns a workspaces row. This exercises
// finalizeAgentRun end-to-end through a real launchAgentRun against a real git
// repo: launch the tree (allocator + reuser), then drive a clean Done exit for
// EACH and assert BOTH settle to Review with a run.review domain event + a
// retained acp_session_id.
//
// RED today: (1) the launch gate refuses workspaceMode=shared+worktree (until T6
// removes it), then (2) finalStatusForCleanAgentExit(hasWorkspace) lands the
// reuser (no workspaces row) at Done instead of Review.

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
let finalizeAgentRun: typeof import("@/lib/agents/launch").finalizeAgentRun;

beforeAll(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "maister-fst-cache-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ launchAgentRun, finalizeAgentRun } = await import("@/lib/agents/launch"));
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
  worktreesTmp = await mkdtemp(path.join(os.homedir(), ".maister-fst-wt-"));
  originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
  process.env.MAISTER_WORKTREES_ROOT = worktreesTmp;

  await pool.query(`DELETE FROM "domain_events"`);
  await pool.query(`DELETE FROM "workspaces"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
  await pool.query(`DELETE FROM "projects"`);

  // A real git repo for shared-worktree allocation.
  repoPath = await mkdtemp(path.join(os.homedir(), ".maister-fst-repo-"));
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

// Install one package revision with worktree-mode agents + an enabled trusted
// flow, and register every agent in the catalog index + attach it to the
// project. Mirrors seedPackageWithAgents in launch-worktree-modes.integration.
async function seedPackageWithAgents(
  agents: Array<{ stem: string; workspace: "none" | "repo_read" | "worktree" }>,
): Promise<Record<string, string>> {
  const revisionId = randomUUID();
  const installedPath = path.join(cacheRoot, `pkg-${revisionId.slice(0, 8)}`);

  await mkdir(path.join(installedPath, "agents"), { recursive: true });

  const ids: Record<string, string> = {};

  for (const a of agents) {
    await writeFile(
      path.join(installedPath, "agents", `${a.stem}.md`),
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
        path.join(installedPath, "agents", `${a.stem}.md`),
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

async function runStatus(id: string): Promise<string | null> {
  const r = await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [
    id,
  ]);

  return r.rows[0]?.status ?? null;
}

async function acpSessionId(id: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT "acp_session_id" FROM "runs" WHERE "id" = $1`,
    [id],
  );

  return r.rows[0]?.acp_session_id ?? null;
}

// Make a launched-Pending child eligible for a clean Done finalize: the
// finalize CAS source for Done is ["Running","NeedsInput"], and a delegated
// child reaching Review keeps its acp handle, so stamp a session id now to
// assert it survives the flip.
async function makeRunningWithSession(
  runId: string,
  session: string,
): Promise<void> {
  await pool.query(
    `UPDATE "runs" SET "status" = 'Running', "acp_session_id" = $2 WHERE "id" = $1`,
    [runId, session],
  );
}

async function reviewEventCount(runId: string, parentRunId: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM "domain_events"
       WHERE "run_id" = $1 AND "kind" = 'run.review'
         AND "payload"->>'parentRunId' = $2`,
    [runId, parentRunId],
  );

  return r.rows[0].n;
}

describe("ADR-101 — shared writable child finalizes to Review regardless of hasWorkspace", () => {
  it("BOTH the allocator AND the reuser shared child settle Review (not Done) on a clean Done exit, emit run.review(parent), keep acp_session_id", async () => {
    const ids = await seedPackageWithAgents([
      { stem: "coordinator", workspace: "worktree" },
      { stem: "worker", workspace: "worktree" },
    ]);
    const root = await insertRoot();

    // The allocator owns the single shared `workspaces` row; the reuser gets
    // none (worktree_path is UNIQUE on the tree the allocator created).
    const allocator = await launchAgentRun({
      agentId: ids.worker,
      projectId,
      parentRunId: root,
      rootRunId: root,
      launchMode: "manual",
      workspaceMode: "shared",
      trigger: { source: "manual" },
      db,
    });
    const reuser = await launchAgentRun({
      agentId: ids.worker,
      projectId,
      parentRunId: root,
      rootRunId: root,
      launchMode: "manual",
      workspaceMode: "shared",
      trigger: { source: "manual" },
      db,
    });

    if ("deduped" in allocator || "deduped" in reuser) {
      throw new Error("delegated launch unexpectedly deduped");
    }

    // Sanity: exactly the allocator owns a workspaces row; the reuser owns none.
    const allocatorWs = await pool.query(
      `SELECT count(*)::int AS n FROM "workspaces" WHERE "run_id" = $1`,
      [allocator.runId],
    );
    const reuserWs = await pool.query(
      `SELECT count(*)::int AS n FROM "workspaces" WHERE "run_id" = $1`,
      [reuser.runId],
    );

    expect(allocatorWs.rows[0].n).toBe(1);
    expect(reuserWs.rows[0].n).toBe(0);

    // Drive a clean Done exit for EACH child (the consume loop's clean-end path).
    await makeRunningWithSession(allocator.runId, "acp-allocator-keep");
    await makeRunningWithSession(reuser.runId, "acp-reuser-keep");

    const allocatorResult = await finalizeAgentRun(allocator.runId, "Done", {
      db,
    });
    const reuserResult = await finalizeAgentRun(reuser.runId, "Done", { db });

    // BOTH land in Review — a shared writable child is never auto-Done, even the
    // reuser that owns no workspaces row of its own.
    expect(allocatorResult.status).toBe("Review");
    expect(reuserResult.status).toBe("Review");
    expect(await runStatus(allocator.runId)).toBe("Review");
    expect(await runStatus(reuser.runId)).toBe("Review");

    // Each emits a run.review domain event carrying the orchestrator parent.
    expect(await reviewEventCount(allocator.runId, root)).toBe(1);
    expect(await reviewEventCount(reuser.runId, root)).toBe(1);

    // Each keeps its resume handle (a delegated Review preserves acp_session_id
    // for run_rework's session/resume).
    expect(await acpSessionId(allocator.runId)).toBe("acp-allocator-keep");
    expect(await acpSessionId(reuser.runId)).toBe("acp-reuser-keep");
  });
});
