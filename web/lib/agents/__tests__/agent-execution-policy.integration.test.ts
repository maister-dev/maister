// M39 Phase 5 (ADR-106) — T5.1: launchAgentRun resolves the effective runner
// policy (autoApply → B1/B2 axes, onBudgetBreach → the budget axis) in the Q3
// order instance-override → agent recommended → supervised floor, and snapshots
// it onto runs.execution_policy at spawn. The effective recommendation is read
// from the pinned package revision's `maister-agents/<stem>.md` frontmatter (NOT
// the catalog row), so each agent ships its own .md. The background
// startAgentSession has no live supervisor and fails harmlessly — only the
// at-insert snapshot is asserted.
import type { AgentSupervisorApi } from "@/lib/agents/launch";
import type { SupervisorEvent } from "@/lib/supervisor-client";

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
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Stub the scheduler so launchAgentRun never spawns a supervisor session — the
// run stays Pending and the execution_policy snapshot (set at the INSERT) is
// asserted in isolation, with no fire-and-forget background DB work to race the
// container teardown.
vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

const exec = promisify(execFile);

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let agentsRoot: string;
let repoPath: string;
let projectId: string;
let installId: string;
let worktreesTmp: string;
let originalWorktreesRoot: string | undefined;
let launchAgentRun: typeof import("@/lib/agents/launch").launchAgentRun;
let startAgentSession: typeof import("@/lib/agents/launch").startAgentSession;

beforeAll(async () => {
  agentsRoot = await mkdtemp(path.join(os.tmpdir(), "maister-aexec-"));
  await mkdir(path.join(agentsRoot, "maister-agents"), { recursive: true });
  worktreesTmp = await mkdtemp(path.join(os.homedir(), ".maister-aexec-wt-"));
  originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
  process.env.MAISTER_WORKTREES_ROOT = worktreesTmp;

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  process.env.DB_URL = container.getConnectionUri();

  ({ launchAgentRun, startAgentSession } = await import("@/lib/agents/launch"));
}, 180_000);

afterAll(async () => {
  if (originalWorktreesRoot === undefined)
    delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = originalWorktreesRoot;
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "project_package_attachments"`);
  await pool.query(`DELETE FROM "package_installs"`);
  await pool.query(`DELETE FROM "projects"`);

  repoPath = await mkdtemp(path.join(os.homedir(), ".maister-aexec-repo-"));
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
     VALUES ('aexec-runner', 'claude', 'claude', 'claude-sonnet-4-6', '{"kind":"anthropic"}'::jsonb, 'Ready')
     ON CONFLICT (id) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO "platform_runtime_settings" ("id", "default_runner_id")
     VALUES ('singleton', 'aexec-runner') ON CONFLICT (id) DO UPDATE SET "default_runner_id" = 'aexec-runner'`,
  );

  installId = randomUUID();
  await pool.query(
    `INSERT INTO "package_installs" ("id", "source_url", "name", "version_label", "resolved_revision", "manifest", "manifest_digest", "installed_path", "package_status", "trust_status")
     VALUES ($1, 'github.com/acme/pkg', 'pkg', 'v1.0.0', 'rev-pkg-1', '{}'::jsonb, 'digest', $2, 'Installed', 'trusted')`,
    [installId, agentsRoot],
  );
  await pool.query(
    `INSERT INTO "project_package_attachments" ("id", "project_id", "package_install_id", "package_name") VALUES ($1, $2, $3, 'pkg')`,
    [randomUUID(), projectId, installId],
  );
});

// Seed a standalone (no flow_ref) workspace=none agent with an optional
// `recommended.executionPolicy` frontmatter block and an optional per-project
// link policy override.
async function seedAgent(args: {
  stem: string;
  recommendedYaml?: string;
  linkOverride?: Record<string, unknown> | null;
}): Promise<string> {
  const id = `pkg:${args.stem}`;
  const recommendedBlock = args.recommendedYaml
    ? `recommended:\n${args.recommendedYaml}`
    : "";

  await writeFile(
    path.join(agentsRoot, "maister-agents", `${args.stem}.md`),
    `---
name: ${args.stem}
description: a standalone agent
workspace: none
mode: session
triggers:
  - manual
risk_tier: read_only
${recommendedBlock}
---
You are ${args.stem}.
`,
    "utf8",
  );
  await pool.query(
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path")
     VALUES ($1, 'pkg', 'v1.0.0', 'git', $2, 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', $3)`,
    [id, args.stem, path.join(agentsRoot, "maister-agents", `${args.stem}.md`)],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id", "execution_policy_override")
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      randomUUID(),
      id,
      projectId,
      args.linkOverride ? JSON.stringify(args.linkOverride) : null,
    ],
  );

  return id;
}

async function getRunPolicy(runId: string): Promise<unknown> {
  const rows = await pool.query(
    `SELECT execution_policy FROM runs WHERE id = $1`,
    [runId],
  );

  return rows.rows[0]?.execution_policy;
}

async function launchAndReadPolicy(agentId: string): Promise<unknown> {
  const result = await launchAgentRun({
    agentId,
    projectId,
    trigger: { source: "manual" },
    db,
  });

  expect("runId" in result).toBe(true);
  if (!("runId" in result)) throw new Error("launch deduped unexpectedly");

  return getRunPolicy(result.runId);
}

describe("launchAgentRun — execution-policy snapshot (M39 T5.1, ADR-106)", () => {
  it("maps recommended {autoApply:'permissions', onBudgetBreach:'terminate_restorable'} onto the run snapshot", async () => {
    const id = await seedAgent({
      stem: "recommender",
      recommendedYaml:
        "  executionPolicy:\n    autoApply: permissions\n    onBudgetBreach: terminate_restorable",
    });

    expect(await launchAndReadPolicy(id)).toEqual({
      preset: "supervised",
      overrides: {
        permissions: "auto_approve",
        humanGate: "stop",
        onBudgetBreach: "terminate_restorable",
      },
    });
  });

  it("the per-project link override beats the agent recommendation (Q3 precedence)", async () => {
    const id = await seedAgent({
      stem: "overridden",
      recommendedYaml: '  executionPolicy:\n    autoApply: "off"',
      linkOverride: { autoApply: "full" },
    });

    expect(await launchAndReadPolicy(id)).toEqual({
      preset: "supervised",
      overrides: { permissions: "auto_approve", humanGate: "auto_pass" },
    });
  });

  it("an agent with no declared policy snapshots the bare supervised default", async () => {
    const id = await seedAgent({ stem: "plain" });

    expect(await launchAndReadPolicy(id)).toEqual({ preset: "supervised" });
  });
});

// A fake supervisor API recording the createSession input; its session stream
// yields a single `checkpoint` exit so consumeAgentSession detaches with no DB
// work (the keep-alive sweeper owns the idle transition — never reached here).
function recordingApi(): {
  api: AgentSupervisorApi;
  createSessionCalls: Array<Record<string, unknown>>;
} {
  const createSessionCalls: Array<Record<string, unknown>> = [];
  const api = {
    createSession: async (input: Record<string, unknown>) => {
      createSessionCalls.push(input);

      return { sessionId: "sup-aa", acpSessionId: "acp-aa" };
    },
    deliverPermission: async () => ({}),
    sendPrompt: async () => ({}),
    streamSession: async function* (): AsyncGenerator<SupervisorEvent> {
      yield {
        type: "session.exited",
        sessionId: "sup-aa",
        monotonicId: 1,
        exitCode: 0,
        reason: "checkpoint",
      };
    },
  } as unknown as AgentSupervisorApi;

  return { api, createSessionCalls };
}

async function launchRunningAgent(agentId: string): Promise<string> {
  const result = await launchAgentRun({
    agentId,
    projectId,
    trigger: { source: "manual" },
    db,
  });

  if (!("runId" in result)) throw new Error("launch deduped unexpectedly");
  await pool.query(`UPDATE "runs" SET "status" = 'Running' WHERE "id" = $1`, [
    result.runId,
  ]);

  return result.runId;
}

describe("startAgentSession — autoApply → supervisor auto-approve (M39 T5.2, ADR-106)", () => {
  it("threads autoApprovePermissions=true into createSession for an autoApply='permissions' agent", async () => {
    const id = await seedAgent({
      stem: "approver",
      recommendedYaml: "  executionPolicy:\n    autoApply: permissions",
    });
    const runId = await launchRunningAgent(id);
    const { api, createSessionCalls } = recordingApi();

    await startAgentSession(runId, { db, api });

    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].autoApprovePermissions).toBe(true);
  });

  it("threads autoApprovePermissions=false for an agent with no autoApply (normal HITL)", async () => {
    const id = await seedAgent({ stem: "asker" });
    const runId = await launchRunningAgent(id);
    const { api, createSessionCalls } = recordingApi();

    await startAgentSession(runId, { db, api });

    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0].autoApprovePermissions).toBe(false);
  });
});
