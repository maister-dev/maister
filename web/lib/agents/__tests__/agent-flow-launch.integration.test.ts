// M39 (ADR-106) — the launch branch of optional-flow enrichment: launchAgentRun
// branches on the flow_ref discriminant BEFORE the standalone routing. An agent
// declaring a same-package flow drives that flow as a run_kind='flow' run
// carrying runs.agent_id (reusing the board launch `launchRun`); a task-less
// trigger auto-creates the board task the graph runner requires. We assert the
// run's identity columns (set at insert); the background runFlow has no live
// supervisor and fails harmlessly (caught by launchRun) — not observed here.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

const exec = promisify(execFile);

// Stub the scheduler so the flow launch stays Pending and never fires the
// fire-and-forget background runFlow (which has no live supervisor + would race
// the container teardown). The run's identity + execution_policy snapshot are
// set at the INSERT, so every assertion below holds without starting the run.
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
let agentsRoot: string;
let worktreesTmp: string;
let repoPath: string;
let projectId: string;
let originalWorktreesRoot: string | undefined;
let launchAgentRun: typeof import("@/lib/agents/launch").launchAgentRun;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-aflaunch-"));
  await mkdir(path.join(agentsRoot, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(agentsRoot, "maister-agents", "driver.md"),
    `---
name: Driver
description: drives a flow
workspace: worktree
mode: session
triggers:
  - manual
  - cron
risk_tier: read_only
flow: bugfix
recommended:
  executionPolicy:
    autoApply: full
---
You are the driving persona.
`,
    "utf8",
  );

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  process.env.DB_URL = container.getConnectionUri();

  ({ launchAgentRun } = await import("@/lib/agents/launch"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  worktreesTmp = await mkdtemp(
    path.join(os.homedir(), ".maister-aflaunch-wt-"),
  );
  originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
  process.env.MAISTER_WORKTREES_ROOT = worktreesTmp;

  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "tasks"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "project_package_attachments"`);
  await pool.query(`DELETE FROM "package_installs"`);
  await pool.query(`DELETE FROM "flows"`);
  await pool.query(`DELETE FROM "flow_revisions"`);
  await pool.query(`DELETE FROM "projects"`);

  repoPath = await mkdtemp(path.join(os.homedir(), ".maister-aflaunch-repo-"));
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
  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', $3, 'main', 'maister/', '/tmp/m.yaml', $4, 1)`,
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
    `INSERT INTO "platform_acp_runners" ("id", "adapter", "capability_agent", "model", "provider", "readiness_status")
     VALUES ('afl-runner', 'claude', 'claude', 'claude-sonnet-4-6', '{"kind":"anthropic"}'::jsonb, 'Ready')
     ON CONFLICT (id) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', 'afl-runner') ON CONFLICT (id) DO UPDATE SET "default_runner_id" = 'afl-runner'`,
  );

  // The driving agent's package (attached + trusted) — id `pkg:driver`.
  const installId = randomUUID();

  await pool.query(
    `INSERT INTO "package_installs" ("id", "source_url", "name", "version_label", "resolved_revision", "manifest", "manifest_digest", "installed_path", "package_status", "trust_status")
     VALUES ($1, 'github.com/acme/pkg', 'pkg', 'v1.0.0', 'rev-pkg-1', '{}'::jsonb, 'digest', $2, 'Installed', 'trusted')`,
    [installId, agentsRoot],
  );
  await pool.query(
    `INSERT INTO "project_package_attachments" ("id", "project_id", "package_install_id", "package_name") VALUES ($1, $2, $3, 'pkg')`,
    [randomUUID(), projectId, installId],
  );
  await pool.query(
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "flow_ref", "source_path")
     VALUES ('pkg:driver', 'pkg', 'v1.0.0', 'git', 'Driver', 'd', 'worktree', 'session', '["manual","cron"]'::jsonb, 'read_only', 'bugfix', $1)`,
    [path.join(agentsRoot, "maister-agents", "driver.md")],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id") VALUES ($1, 'pkg:driver', $2)`,
    [randomUUID(), projectId],
  );

  // The same-package flow `bugfix` the agent drives: an Enabled + trusted flow
  // row pinned to an Installed revision (a minimal one-node ai_coding manifest).
  const revisionId = randomUUID();
  const manifest = {
    schemaVersion: 1,
    name: "bugfix",
    compat: { engine_min: "1.3.0" },
    nodes: [
      {
        id: "code",
        type: "ai_coding",
        action: { prompt: "fix it" },
        transitions: { success: "done" },
      },
    ],
  };

  await pool.query(
    `INSERT INTO "flow_revisions" ("id", "flow_ref_id", "source", "version_label", "resolved_revision", "manifest_digest", "manifest", "schema_version", "installed_path", "package_status", "setup_status", "exec_trust")
     VALUES ($1, 'bugfix', 'github.com/acme/pkg', 'v1.0.0', 'rev-bugfix-1', 'digest', $2::jsonb, 1, $3, 'Installed', 'not_required', 'trusted')`,
    [revisionId, JSON.stringify(manifest), agentsRoot],
  );
  await pool.query(
    `INSERT INTO "flows" ("id", "project_id", "flow_ref_id", "source", "version", "installed_path", "manifest", "schema_version", "enabled_revision_id", "enablement_state", "trust_status", "version_binding")
     VALUES ($1, $2, 'bugfix', 'github.com/acme/pkg', 'v1.0.0', $3, $4::jsonb, 1, $5, 'Enabled', 'trusted', 'pinned')`,
    [randomUUID(), projectId, agentsRoot, JSON.stringify(manifest), revisionId],
  );
});

afterEach(async () => {
  if (originalWorktreesRoot === undefined)
    delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = originalWorktreesRoot;
});

async function getRun(runId: string): Promise<Record<string, unknown>> {
  const rows = await pool.query(
    `SELECT run_kind, agent_id, flow_id, task_id, status FROM runs WHERE id = $1`,
    [runId],
  );

  return rows.rows[0];
}

describe("launchAgentRun — agent drives a flow (M39, ADR-106)", () => {
  it("a task-bound launch creates a run_kind='flow' run carrying agent_id + flowId on the agent's same-package flow", async () => {
    const taskRes = await pool.query(
      `INSERT INTO "tasks" ("id", "project_id", "number", "title", "prompt", "status", "stage") VALUES ($1, $2, 1, 't', 'p', 'Backlog', 'Backlog') RETURNING id`,
      [randomUUID(), projectId],
    );
    const taskId = taskRes.rows[0].id as string;

    const result = await launchAgentRun({
      agentId: "pkg:driver",
      projectId,
      taskId,
      trigger: { source: "manual" },
      db,
    });

    expect("runId" in result).toBe(true);
    if (!("runId" in result)) return;

    const run = await getRun(result.runId);

    expect(run.run_kind).toBe("flow");
    expect(run.agent_id).toBe("pkg:driver");
    expect(run.flow_id).not.toBeNull();
    expect(run.task_id).toBe(taskId);
  });

  it("a task-less trigger auto-creates a board task, then runs the flow (run_kind='flow' + agent_id)", async () => {
    const result = await launchAgentRun({
      agentId: "pkg:driver",
      projectId,
      trigger: { source: "cron" },
      db,
    });

    expect("runId" in result).toBe(true);
    if (!("runId" in result)) return;

    const run = await getRun(result.runId);

    expect(run.run_kind).toBe("flow");
    expect(run.agent_id).toBe("pkg:driver");
    expect(run.task_id).not.toBeNull();

    // The auto-created board task carries the same flow.
    const task = await pool.query(`SELECT flow_id FROM tasks WHERE id = $1`, [
      run.task_id,
    ]);

    expect(task.rows[0].flow_id).toBe(run.flow_id);
  });

  it("imposes the flow-driving agent's runner policy on the flow run (autoApply='full' → B1 auto_approve + B2 auto_pass on execution_policy)", async () => {
    const result = await launchAgentRun({
      agentId: "pkg:driver",
      projectId,
      trigger: { source: "manual" },
      db,
    });

    expect("runId" in result).toBe(true);
    if (!("runId" in result)) return;

    const rows = await pool.query(
      `SELECT execution_policy FROM runs WHERE id = $1`,
      [result.runId],
    );

    // launchAgentDrivenFlowRun passes the agent's resolved policy as the launch
    // override; the flow runner's existing B1/B2 enforcement reads it back.
    expect(rows.rows[0].execution_policy).toMatchObject({
      overrides: { permissions: "auto_approve", humanGate: "auto_pass" },
    });
  });
});
