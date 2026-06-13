import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
} from "vitest";

import {
  filterManifestPorcelain,
  materializeAgentReadOnlySettings,
} from "@/lib/agents/dirty-watchdog";
import { finalizeAgentRun } from "@/lib/agents/launch";
import { isMaisterError } from "@/lib/errors";

const exec = promisify(execFile);

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let repoPath: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
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
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "projects"`);

  repoPath = await mkdtemp(path.join(os.tmpdir(), "maister-watchdog-"));
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
});

async function seedWorld(): Promise<{
  projectId: string;
  taskId: string;
  runId: string;
}> {
  const projectId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/maister.yaml', $4, 2)`,
    [
      projectId,
      `p-${projectId.slice(0, 8)}`,
      repoPath,
      `K${projectId
        .replace(/[^0-9A-Za-z]/g, "")
        .slice(0, 7)
        .toUpperCase()}`,
    ],
  );
  await pool.query(
    `INSERT INTO "agents" ("id", "flow_ref_id", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
     VALUES ('watchdog-agent', 'test-pkg', 'v1.0.0', 'git', 'W', 'd', 'repo_read', 'session', '["manual"]'::jsonb, 'read_only', '/tmp/agent.md')`,
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, 'watchdog-agent', $2)`,
    [randomUUID(), projectId],
  );

  const taskId = randomUUID();

  await pool.query(
    `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt")
     VALUES ($1, $2, 1, 'task', 'prompt')`,
    [taskId, projectId],
  );

  const runId = randomUUID();

  await pool.query(
    `INSERT INTO "runs" ("id", "run_kind", "agent_id", "trigger_source", "task_id", "project_id", "flow_version", "flow_revision", "status")
     VALUES ($1, 'agent', 'watchdog-agent', 'manual', $2, $3, 'agent', 'manual', 'Running')`,
    [runId, taskId, projectId],
  );

  return { projectId, taskId, runId };
}

describe("filterManifestPorcelain", () => {
  it("drops only the manifest-tracked lines", () => {
    const porcelain = [
      "?? .claude/settings.local.json",
      "?? .claude/settings.local.json.maister-owned",
      " M src/index.ts",
    ].join("\n");

    expect(filterManifestPorcelain(porcelain)).toBe(" M src/index.ts");
    expect(
      filterManifestPorcelain(
        "?? .claude/settings.local.json\n?? .claude/settings.local.json.maister-owned\n",
      ),
    ).toBe("");
  });
});

describe("dirty-watchdog terminal choke point (ADR-090 L3)", () => {
  it("dirty repo_read run → quarantine + system comment + activity, relaunch refused", async () => {
    const { taskId, runId } = await seedWorld();

    await writeFile(path.join(repoPath, "stray.txt"), "agent wrote this\n");

    const result = await finalizeAgentRun(runId, "Done", { db });

    expect(result.finalized).toBe(true);

    const agentRow = await pool.query(
      `SELECT "quarantined_at", "quarantine_reason" FROM "agents" WHERE "id" = 'watchdog-agent'`,
    );

    expect(agentRow.rows[0].quarantined_at).not.toBeNull();
    expect(agentRow.rows[0].quarantine_reason).toMatch(/stray\.txt/);

    const comments = await pool.query(
      `SELECT "body", "actor_type" FROM "task_comments" WHERE "task_id" = $1`,
      [taskId],
    );

    expect(comments.rows).toHaveLength(1);
    expect(comments.rows[0].actor_type).toBe("system");
    expect(comments.rows[0].body).toMatch(/quarantined/);

    const activity = await pool.query(
      `SELECT "event_kind" FROM "task_activity" WHERE "task_id" = $1 AND "event_kind" = 'agent_quarantined'`,
      [taskId],
    );

    expect(activity.rows).toHaveLength(1);

    // The run itself reached its terminal status.
    const run = await pool.query(
      `SELECT "status" FROM "runs" WHERE "id" = $1`,
      [runId],
    );

    expect(run.rows[0].status).toBe("Done");

    // Every later launch entry point refuses the quarantined agent.
    const { launchAgentRun } = await import("@/lib/agents/launch");

    await expect(
      launchAgentRun({
        agentId: "watchdog-agent",
        projectId: (await seedWorldProjectId())!,
        trigger: { source: "manual" },
        db,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "PRECONDITION" &&
        /quarantined/.test(err.message),
    );
  });

  it("clean repo_read run → no quarantine, L2 materialization restored", async () => {
    const { taskId, runId } = await seedWorld();

    await materializeAgentReadOnlySettings(repoPath);
    expect(
      await statSafe(path.join(repoPath, ".claude/settings.local.json")),
    ).toBe(true);

    const result = await finalizeAgentRun(runId, "Done", { db });

    expect(result.finalized).toBe(true);

    const agentRow = await pool.query(
      `SELECT "quarantined_at" FROM "agents" WHERE "id" = 'watchdog-agent'`,
    );

    expect(agentRow.rows[0].quarantined_at).toBeNull();
    expect(
      await statSafe(path.join(repoPath, ".claude/settings.local.json")),
    ).toBe(false);

    const comments = await pool.query(
      `SELECT count(*)::int AS n FROM "task_comments" WHERE "task_id" = $1`,
      [taskId],
    );

    expect(comments.rows[0].n).toBe(0);

    await rm(repoPath, { recursive: true, force: true });
  });

  it("clean worktree run → Review, not Done, so promotion remains explicit", async () => {
    const { runId, projectId } = await seedWorld();

    await pool.query(
      `UPDATE "agents" SET "workspace" = 'worktree' WHERE "id" = 'watchdog-agent'`,
    );
    await pool.query(
      `INSERT INTO "workspaces" ("id", "run_id", "project_id", "branch", "worktree_path", "parent_repo_path", "base_branch", "base_commit", "target_branch")
       VALUES ($1, $2, $3, 'maister/agent-watchdog-agent-12345678', $4, $5, 'main', 'base0000', 'main')`,
      [randomUUID(), runId, projectId, `/tmp/${runId}-agent-wt`, repoPath],
    );

    const result = await finalizeAgentRun(runId, "Done", { db });

    expect(result).toMatchObject({ finalized: true, status: "Review" });

    const run = await pool.query(
      `SELECT "status" FROM "runs" WHERE "id" = $1`,
      [runId],
    );

    expect(run.rows[0].status).toBe("Review");

    const webhookRows = await pool.query(
      `SELECT "type" FROM "webhook_events" WHERE "run_id" = $1 ORDER BY "created_at"`,
      [runId],
    );

    expect(webhookRows.rows.map((row) => row.type)).toEqual(["run.review"]);

    const domainRows = await pool.query(
      `SELECT "kind" FROM "domain_events" WHERE "run_id" = $1`,
      [runId],
    );

    expect(domainRows.rows).toHaveLength(0);
  });

  it("gates L3 on the run's persisted agent_workspace, not the drifted catalog index", async () => {
    // The run actually launched as repo_read (project pin), but the catalog
    // INDEX (newest revision projection) has since drifted to 'worktree'.
    // Reading the index would silently skip L3; the run column must win.
    const { taskId, runId } = await seedWorld();

    await pool.query(
      `UPDATE "runs" SET "agent_workspace" = 'repo_read' WHERE "id" = $1`,
      [runId],
    );
    await pool.query(
      `UPDATE "agents" SET "workspace" = 'worktree' WHERE "id" = 'watchdog-agent'`,
    );

    await writeFile(path.join(repoPath, "stray.txt"), "agent wrote this\n");

    const result = await finalizeAgentRun(runId, "Done", { db });

    expect(result.finalized).toBe(true);

    const agentRow = await pool.query(
      `SELECT "quarantined_at", "quarantine_reason" FROM "agents" WHERE "id" = 'watchdog-agent'`,
    );

    // Quarantined despite the index saying 'worktree' — finalize honored the
    // run's recorded workspace axis.
    expect(agentRow.rows[0].quarantined_at).not.toBeNull();
    expect(agentRow.rows[0].quarantine_reason).toMatch(/stray\.txt/);

    const activity = await pool.query(
      `SELECT "event_kind" FROM "task_activity" WHERE "task_id" = $1 AND "event_kind" = 'agent_quarantined'`,
      [taskId],
    );

    expect(activity.rows).toHaveLength(1);
  });

  it("abandoned repo_read run still revokes tokens and restores L2 materialization", async () => {
    const { runId } = await seedWorld();

    await materializeAgentReadOnlySettings(repoPath);
    await expect(issueTokenForRun(runId)).resolves.toMatchObject({
      tokenId: expect.any(String),
    });

    const finalizeAbandoned = finalizeAgentRun as (
      id: string,
      outcome: "Abandoned",
      opts: { db: typeof db },
    ) => Promise<{ finalized: boolean }>;
    const result = await finalizeAbandoned(runId, "Abandoned", { db });

    expect(result.finalized).toBe(true);

    const liveTokens = await pool.query(
      `SELECT count(*)::int AS n FROM "project_tokens" WHERE "name" = $1 AND "revoked_at" IS NULL`,
      [`agent-run:${runId}`],
    );

    expect(liveTokens.rows[0].n).toBe(0);
    expect(
      await statSafe(path.join(repoPath, ".claude/settings.local.json")),
    ).toBe(false);
  });
});

async function issueTokenForRun(
  runId: string,
): Promise<{ tokenId: string; secret: string }> {
  const row = await pool.query(
    `SELECT "project_id" FROM "runs" WHERE "id" = $1`,
    [runId],
  );
  const { issueAgentRunToken } = await import("@/lib/agents/tokens");

  return issueAgentRunToken({
    agentId: "watchdog-agent",
    projectId: row.rows[0].project_id as string,
    runId,
    db,
  });
}

async function statSafe(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch {
    return false;
  }
}

async function seedWorldProjectId(): Promise<string | null> {
  const res = await pool.query(`SELECT "id" FROM "projects" LIMIT 1`);

  return (res.rows[0]?.id as string) ?? null;
}

describe("workspace_ref ephemeral checkout (ADR-090 rework, RD6)", () => {
  let worktreesTmp: string;
  let originalWorktreesRoot: string | undefined;

  beforeEach(async () => {
    worktreesTmp = await mkdtemp(path.join(os.tmpdir(), "maister-wt-"));
    originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
    process.env.MAISTER_WORKTREES_ROOT = worktreesTmp;
  });

  afterEach(async () => {
    if (originalWorktreesRoot === undefined) {
      delete process.env.MAISTER_WORKTREES_ROOT;
    } else {
      process.env.MAISTER_WORKTREES_ROOT = originalWorktreesRoot;
    }
    await rm(worktreesTmp, { recursive: true, force: true });
  });

  async function seedEphemeralRun(): Promise<{
    runId: string;
    slug: string;
    ephemeralPath: string;
  }> {
    const { runId } = await seedWorld();
    const slugRow = await pool.query(`SELECT "slug" FROM "projects" LIMIT 1`);
    const slug = slugRow.rows[0].slug as string;
    const { agentReadOnlyWorkdirPath } = await import("@/lib/agents/launch");
    const { addDetachedWorktree } = await import("@/lib/worktree");
    const ephemeralPath = agentReadOnlyWorkdirPath(slug, runId);

    await addDetachedWorktree({
      projectRepoPath: repoPath,
      worktreePath: ephemeralPath,
      committish: "main",
    });

    return { runId, slug, ephemeralPath };
  }

  it("L3 targets the ephemeral dir (dirty parent stays unattributed) and removes it after", async () => {
    const { runId, ephemeralPath } = await seedEphemeralRun();

    // Dirty the PARENT checkout: with an ephemeral session cwd this is NOT
    // the agent's doing and must not quarantine.
    await writeFile(path.join(repoPath, "user-edit.txt"), "human edit\n");

    const result = await finalizeAgentRun(runId, "Done", { db });

    expect(result.finalized).toBe(true);

    const agentRow = await pool.query(
      `SELECT "quarantined_at" FROM "agents" WHERE "id" = 'watchdog-agent'`,
    );

    expect(agentRow.rows[0].quarantined_at).toBeNull();
    // The ephemeral checkout is gone after the terminal choke point.
    expect(await statSafe(ephemeralPath)).toBe(false);
  });

  it("a dirty ephemeral checkout quarantines naming the -ro path, then removes it", async () => {
    const { runId, ephemeralPath } = await seedEphemeralRun();

    await writeFile(path.join(ephemeralPath, "stray.txt"), "agent wrote\n");

    const result = await finalizeAgentRun(runId, "Done", { db });

    expect(result.finalized).toBe(true);

    const agentRow = await pool.query(
      `SELECT "quarantined_at", "quarantine_reason" FROM "agents" WHERE "id" = 'watchdog-agent'`,
    );

    expect(agentRow.rows[0].quarantined_at).not.toBeNull();
    expect(agentRow.rows[0].quarantine_reason).toMatch(/-ro/);
    expect(agentRow.rows[0].quarantine_reason).toMatch(/stray\.txt/);
    expect(await statSafe(ephemeralPath)).toBe(false);
  });
});

describe("resolveWorkspaceRefCommittish (RD6 v1)", () => {
  it("resolves a literal branch, webhook payload branch/ref, and run.* event branches; refuses the rest", async () => {
    const { runId, projectId } = await (async () => {
      const world = await seedWorld();

      return { runId: world.runId, projectId: world.projectId };
    })();
    const { resolveWorkspaceRefCommittish } = await import(
      "@/lib/agents/launch"
    );

    // Literal branch resolves to the commit sha.
    const literal = await resolveWorkspaceRefCommittish(db, {
      agentId: "test-pkg:a",
      workspaceRef: "main",
      repoPath,
      trigger: { source: "manual" },
    });

    expect(literal).toMatch(/^[0-9a-f]{40}$/);

    // Unresolvable literal → PRECONDITION (no auto-fetch in v1).
    await expect(
      resolveWorkspaceRefCommittish(db, {
        agentId: "test-pkg:a",
        workspaceRef: "no-such-branch",
        repoPath,
        trigger: { source: "manual" },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "PRECONDITION",
    );

    // Webhook: payload `branch` wins, `ref` is the fallback, absence refuses.
    const viaBranch = await resolveWorkspaceRefCommittish(db, {
      agentId: "test-pkg:a",
      workspaceRef: "trigger",
      repoPath,
      trigger: { source: "webhook", payload: { branch: "main" } },
    });

    expect(viaBranch).toBe(literal);

    const viaRef = await resolveWorkspaceRefCommittish(db, {
      agentId: "test-pkg:a",
      workspaceRef: "trigger",
      repoPath,
      trigger: { source: "webhook", payload: { ref: "main" } },
    });

    expect(viaRef).toBe(literal);

    await expect(
      resolveWorkspaceRefCommittish(db, {
        agentId: "test-pkg:a",
        workspaceRef: "trigger",
        repoPath,
        trigger: { source: "webhook", payload: {} },
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "PRECONDITION" &&
        /branch/.test(err.message),
    );

    // domain_event run.* → the triggering run's workspace branch.
    await exec("git", ["-C", repoPath, "branch", "feat-x", "main"]);
    await pool.query(
      `INSERT INTO "workspaces" ("id", "run_id", "project_id", "branch", "worktree_path", "parent_repo_path", "base_branch", "target_branch")
       VALUES ($1, $2, $3, 'feat-x', '/tmp/wt', $4, 'main', 'main')`,
      [randomUUID(), runId, projectId, repoPath],
    );
    const eventRow = await pool.query(
      `INSERT INTO "domain_events" ("kind", "project_id", "run_id", "actor_type", "payload", "occurred_at")
       VALUES ('run.done', $1, $2, 'system', '{}'::jsonb, now()) RETURNING "id"`,
      [projectId, runId],
    );
    const eventId = Number(eventRow.rows[0].id);

    const viaEvent = await resolveWorkspaceRefCommittish(db, {
      agentId: "test-pkg:a",
      workspaceRef: "trigger",
      repoPath,
      trigger: { source: "domain_event", eventId },
    });

    expect(viaEvent).toBe(literal); // feat-x points at main's commit

    // task.* events carry no derivable ref.
    const taskEvent = await pool.query(
      `INSERT INTO "domain_events" ("kind", "project_id", "actor_type", "payload", "occurred_at")
       VALUES ('task.created', $1, 'system', '{}'::jsonb, now()) RETURNING "id"`,
      [projectId],
    );

    await expect(
      resolveWorkspaceRefCommittish(db, {
        agentId: "test-pkg:a",
        workspaceRef: "trigger",
        repoPath,
        trigger: {
          source: "domain_event",
          eventId: Number(taskEvent.rows[0].id),
        },
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMaisterError(err) &&
        err.code === "PRECONDITION" &&
        /run\.\*/.test(err.message),
    );

    // cron/manual sources have no trigger context.
    await expect(
      resolveWorkspaceRefCommittish(db, {
        agentId: "test-pkg:a",
        workspaceRef: "trigger",
        repoPath,
        trigger: { source: "cron" },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "PRECONDITION",
    );
  });
});
