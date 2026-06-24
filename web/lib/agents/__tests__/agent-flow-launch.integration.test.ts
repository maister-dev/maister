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
  - domain_event
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
     VALUES ('pkg:driver', 'pkg', 'v1.0.0', 'git', 'Driver', 'd', 'worktree', 'session', '["manual","cron","domain_event"]'::jsonb, 'read_only', 'bugfix', $1)`,
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

  it("overlays the agent policy onto the project base — the project budget default is NOT shadowed", async () => {
    await pool.query(
      `UPDATE "projects" SET "execution_policy_default" = $1::jsonb WHERE "id" = $2`,
      [
        JSON.stringify({
          preset: "supervised",
          overrides: { budget: { run: { maxTokens: 75000 } } },
        }),
        projectId,
      ],
    );

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

    // The driving agent imposes autoApply='full' (B1/B2), but launchRun resolves
    // its OWN task/project base first and folds the agent axes on top — so the
    // project's run-token ceiling survives (pre-fix the agent policy was passed
    // as a wholesale launch override that shadowed the project budget entirely).
    expect(rows.rows[0].execution_policy).toMatchObject({
      overrides: {
        permissions: "auto_approve",
        humanGate: "auto_pass",
        budget: { run: { maxTokens: 75000 } },
      },
    });
  });

  it("a flow-driving agent's branch_base override forks the flow run from that base (not main)", async () => {
    await exec("git", ["-C", repoPath, "checkout", "-q", "-b", "develop"]);
    await writeFile(path.join(repoPath, "DEV.md"), "dev\n");
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
      "dev",
    ]);
    await exec("git", ["-C", repoPath, "checkout", "-q", "main"]);

    await pool.query(
      `UPDATE "agent_project_links" SET "branch_base" = 'develop' WHERE "agent_id" = 'pkg:driver'`,
    );

    const result = await launchAgentRun({
      agentId: "pkg:driver",
      projectId,
      trigger: { source: "manual" },
      db,
    });

    expect("runId" in result).toBe(true);
    if (!("runId" in result)) return;

    const ws = await pool.query(
      `SELECT base_branch, target_branch FROM workspaces WHERE run_id = $1`,
      [result.runId],
    );

    expect(ws.rows[0].base_branch).toBe("develop");
    expect(ws.rows[0].target_branch).toBe("develop");
  });

  it("at-least-once redelivery of the same trigger event converges to one flow run + one task", async () => {
    const trigger = {
      source: "domain_event" as const,
      eventId: 4242,
      payload: { kind: "task.created" },
    };

    const first = await launchAgentRun({
      agentId: "pkg:driver",
      projectId,
      trigger,
      db,
    });
    const second = await launchAgentRun({
      agentId: "pkg:driver",
      projectId,
      trigger,
      db,
    });

    // The redelivery dedups BEFORE auto-creating a second task / flow run.
    expect("deduped" in second && second.deduped).toBe(true);

    const runRows = await pool.query(
      `SELECT id, trigger_event_id FROM runs WHERE agent_id = 'pkg:driver'`,
    );

    expect(runRows.rows).toHaveLength(1);
    expect(Number(runRows.rows[0].trigger_event_id)).toBe(4242);
    expect("runId" in first && runRows.rows[0].id === first.runId).toBe(true);

    const taskRows = await pool.query(
      `SELECT id FROM tasks WHERE project_id = $1`,
      [projectId],
    );

    expect(taskRows.rows).toHaveLength(1);
  });

  it("CONCURRENT redelivery of the same trigger event converges to ONE flow run + ONE task (two-racer)", async () => {
    const trigger = {
      source: "domain_event" as const,
      eventId: 7777,
      payload: { kind: "task.created" },
    };

    // Genuine race: `db` is Pool-backed, so the two launches run on separate
    // connections and BOTH pass the pre-check before either inserts. The task
    // claim (tasks_agent_trigger_event_uq) makes the loser REUSE the winner's
    // auto-task; the run claim (runs_agent_trigger_event_uq) makes the loser's
    // launchRun throw CONFLICT → reselect the winner. Neither double-creates.
    const [a, b] = await Promise.all([
      launchAgentRun({ agentId: "pkg:driver", projectId, trigger, db }),
      launchAgentRun({ agentId: "pkg:driver", projectId, trigger, db }),
    ]);

    // Neither racer throws, and both observe the SAME single winning run.
    const runIdA = "runId" in a ? a.runId : undefined;
    const runIdB = "runId" in b ? b.runId : undefined;

    expect(runIdA).toBeDefined();
    expect(runIdB).toBeDefined();
    expect(runIdA).toBe(runIdB);

    const runRows = await pool.query(
      `SELECT id, trigger_event_id FROM runs WHERE agent_id = 'pkg:driver'`,
    );

    expect(runRows.rows).toHaveLength(1);
    expect(Number(runRows.rows[0].trigger_event_id)).toBe(7777);
    expect(runRows.rows[0].id).toBe(runIdA);

    // The key idempotency assertion: the concurrent loser did NOT leak an orphan
    // auto-task (pre-fix this was 2).
    const taskRows = await pool.query(
      `SELECT id FROM tasks WHERE project_id = $1`,
      [projectId],
    );

    expect(taskRows.rows).toHaveLength(1);
  });
});
