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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
});

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
