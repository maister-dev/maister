// F1 (ADR-102): the rework path must be FENCED on the shared TREE's
// promotion_state. markReworkFromReview is a pure Review→Running status CAS with
// no promotion_state guard, and reworkChildRun previously only checked the
// child's status==='Review'. So a shared sibling could re-open during the
// lockless merge window; the finalize then aborts CONFLICT but the git target
// already absorbed the merge. The fence: a shared writable agent child resolves +
// locks the tree allocator workspace FOR UPDATE (serializing with the promote
// claim/finalize), and refuses CONFLICT when promotion_state ∈ {claiming, done}.
//
// RED before the fence: with promotion_state='claiming', reworkChildRun ran the
// CAS (Review→Running) and spawned a fresh supervisor session — racing the
// in-flight tree promote.

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

// Supervisor seam: createSession is spied (case (a) asserts it is NOT called when
// the rework is fenced); sendPrompt is a no-op; streamSession ends immediately so
// the GREEN-case consumer detaches without a terminal flip.
const createSessionSpy = vi.fn(
  async (input: { runId: string; resumeSessionId?: string }) => ({
    sessionId: `sup-${input.runId}`,
    pid: 1,
    acpSessionId: input.resumeSessionId ?? `acp-${input.runId}`,
  }),
);

vi.mock("@/lib/supervisor-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/supervisor-client")>();

  return {
    ...actual,
    createSession: (input: unknown) => createSessionSpy(input as never),
    sendPrompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
    streamSession: async function* () {
      return;
    },
    listSessions: vi.fn(async () => []),
  };
});

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let cacheRoot: string;
let worktreesTmp: string;
let originalWorktreesRoot: string | undefined;

let launchAgentRun: typeof import("@/lib/agents/launch").launchAgentRun;
let reworkChildRun: typeof import("@/lib/agents/launch").reworkChildRun;

beforeAll(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "maister-rework-cache-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("shared_tree_rework_fence_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ launchAgentRun, reworkChildRun } = await import("@/lib/agents/launch"));
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
  createSessionSpy.mockClear();

  worktreesTmp = await mkdtemp(path.join(os.homedir(), ".maister-rework-wt-"));
  originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
  process.env.MAISTER_WORKTREES_ROOT = worktreesTmp;

  await pool.query(`DELETE FROM "workspaces"`);
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
  await pool.query(`DELETE FROM "projects"`);

  repoPath = await mkdtemp(path.join(os.homedir(), ".maister-rework-repo-"));
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
  vi.clearAllMocks();
  if (originalWorktreesRoot === undefined) {
    delete process.env.MAISTER_WORKTREES_ROOT;
  } else {
    process.env.MAISTER_WORKTREES_ROOT = originalWorktreesRoot;
  }
  await rm(worktreesTmp, { recursive: true, force: true });
  await rm(repoPath, { recursive: true, force: true });
});

// Install one package revision (agents/<stem>.md resolved from installed_path)
// + an enabled trusted flow, register the agent in the catalog + attach it.
async function seedWorkerAgent(): Promise<string> {
  const revisionId = randomUUID();
  const installedPath = path.join(cacheRoot, `pkg-${revisionId.slice(0, 8)}`);

  await mkdir(path.join(installedPath, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(installedPath, "maister-agents", "worker.md"),
    `---
name: worker
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

  const qualifiedId = "test-pkg:worker";

  await pool.query(
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, 'test-pkg', 'v1.0.0', 'git', 'worker', 'd', 'worktree', 'session', '["manual"]'::jsonb, 'read_only', $2, true)`,
    [qualifiedId, path.join(installedPath, "maister-agents", "worker.md")],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, $2, $3)`,
    [randomUUID(), qualifiedId, projectId],
  );

  return qualifiedId;
}

async function insertRoot(): Promise<string> {
  const id = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "trigger_source", "project_id", "flow_version", "flow_revision", "status", "root_run_id", "runner_id")
     VALUES ($1, 'agent', 'test-pkg:worker', 'manual', $2, 'agent', 'manual', 'WaitingOnChildren', $1, $3)`,
    [id, projectId, executorId],
  );

  return id;
}

// Launch a real shared writable child of `root` (allocator owns the tree
// workspace row), park it in Review with an acp_session_id (the delegated Review
// flip preserves it), and return its id + the tree path.
async function launchSharedReviewChild(
  agentId: string,
  root: string,
): Promise<string> {
  const result = await launchAgentRun({
    agentId,
    projectId,
    parentRunId: root,
    rootRunId: root,
    launchMode: "manual",
    workspaceMode: "shared",
    trigger: { source: "manual" },
    db,
  });

  if ("deduped" in result) throw new Error("unexpected dedup");

  await pool.query(
    `UPDATE "runs" SET "status" = 'Review', "acp_session_id" = $2 WHERE "id" = $1`,
    [result.runId, `acp-${result.runId}`],
  );

  return result.runId;
}

async function runStatus(runId: string): Promise<string | null> {
  const r = await pool.query(`SELECT "status" FROM "runs" WHERE "id" = $1`, [
    runId,
  ]);

  return r.rows[0]?.status ?? null;
}

async function setTreePromotionState(
  root: string,
  state: string,
): Promise<void> {
  await pool.query(
    `UPDATE "workspaces" w SET "promotion_state" = $2
       FROM "runs" r
      WHERE r."id" = w."run_id" AND r."root_run_id" = $1 AND r."workspace_mode" = 'shared'`,
    [root, state],
  );
}

describe("F1 (ADR-102) — rework is fenced on the shared tree promotion_state", () => {
  it("refuses CONFLICT (no session spawned, child stays Review) while a tree promote is claiming", async () => {
    const agentId = await seedWorkerAgent();
    const root = await insertRoot();
    const reviewChild = await launchSharedReviewChild(agentId, root);

    // A tree promote is in flight: the allocator workspace is 'claiming'.
    await setTreePromotionState(root, "claiming");
    createSessionSpy.mockClear();

    await expect(
      reworkChildRun(reviewChild, "please redo it", { db }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "CONFLICT",
    );

    // The fence ran BEFORE the CAS + spawn: the child stays Review and NO fresh
    // supervisor session was created.
    expect(await runStatus(reviewChild)).toBe("Review");
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it("allows the rework (Review→Running) when promotion_state is none", async () => {
    const agentId = await seedWorkerAgent();
    const root = await insertRoot();
    const reviewChild = await launchSharedReviewChild(agentId, root);

    // promotion_state defaults to 'none' (no promote in flight).
    expect(await runStatus(reviewChild)).toBe("Review");

    const result = await reworkChildRun(reviewChild, "please redo it", { db });

    expect(result.status).toBe("Running");
    expect(await runStatus(reviewChild)).toBe("Running");
  });
});
