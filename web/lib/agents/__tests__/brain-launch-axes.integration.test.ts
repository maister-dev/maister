// ADR-122 (T5.3): the run-launch "include ambient brain context" decision is
// persisted to runs.brain_context at launch — the launch writes ONLY the
// boolean (no recall/embedding call, no snapshot insert; those are
// consumption-time, T4.2/T4.3). Driven end-to-end through launchAgentRun with
// tryStartRun stubbed (no supervisor session spawns) against a real Postgres.
// The flow-run launch path (web/lib/services/runs.ts) persists the identical
// `input.brainContext ?? null` passthrough — a field typo there is a compile
// error under strict TS, its ambient consumption is covered by the T4.3
// integration test, so it is not re-asserted here (minimum overlap).
//
// The same file covers the per-link brain axes: agent_project_links
// can_read_brain (gates recall) + can_write_brain (gates retain) are settable +
// independent. The recall 403 for can_read_brain=false is covered by the T4.2
// route test and not duplicated here.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
let updateAgentLink: typeof import("@/lib/agents/project-links").updateAgentLink;
let getProjectAgentsView: typeof import("@/lib/agents/project-links").getProjectAgentsView;

beforeAll(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "maister-brain-cache-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ launchAgentRun } = await import("@/lib/agents/launch"));
  ({ updateAgentLink, getProjectAgentsView } = await import(
    "@/lib/agents/project-links"
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

beforeEach(async () => {
  worktreesTmp = await mkdtemp(path.join(os.homedir(), ".maister-brain-wt-"));
  originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
  process.env.MAISTER_WORKTREES_ROOT = worktreesTmp;

  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agent_project_links"`);
  await pool.query(`DELETE FROM "agents"`);
  await pool.query(`DELETE FROM "project_package_attachments"`);
  await pool.query(`DELETE FROM "package_installs"`);
  await pool.query(`DELETE FROM "projects"`);

  projectId = randomUUID();
  projectSlug = `p-${projectId.slice(0, 8)}`;
  executorId = randomUUID();

  await pool.query(
    `INSERT INTO "projects" ("id", "slug", "name", "repo_path", "main_branch", "branch_prefix", "maister_yaml_path", "task_key", "next_task_number")
     VALUES ($1, $2, 'P', '/tmp/brain-repo', 'main', 'maister/', '/tmp/maister.yaml', $3, 1)`,
    [
      projectId,
      projectSlug,
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
});

// A workspace:none agent (no worktree needed), attached+trusted, so
// launchAgentRun reaches the runs insert without a git worktree.
async function seedAgent(): Promise<string> {
  const installedPath = path.join(cacheRoot, `pkg-${randomUUID().slice(0, 8)}`);

  await mkdir(path.join(installedPath, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(installedPath, "maister-agents", "triager.md"),
    `---
name: Triager
description: d
workspace: none
mode: session
triggers:
  - manual
risk_tier: read_only
---
Classify the task.
`,
    "utf8",
  );

  const packageInstallId = randomUUID();

  await pool.query(
    `INSERT INTO "package_installs"
       ("id", "source_url", "name", "version_label", "resolved_revision",
        "manifest", "manifest_digest", "installed_path", "package_status", "trust_status")
     VALUES ($1, 'github.com/acme/aif', 'aif', 'v1.0.0', 'rev-1',
             '{}'::jsonb, 'digest', $2, 'Installed', 'trusted')`,
    [packageInstallId, installedPath],
  );
  await pool.query(
    `INSERT INTO "project_package_attachments"
       ("id", "project_id", "package_install_id", "package_name")
     VALUES ($1, $2, $3, 'aif')`,
    [randomUUID(), projectId, packageInstallId],
  );

  const agentId = "aif:triager";

  await pool.query(
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "source_path", "enabled")
     VALUES ($1, 'aif', 'v1.0.0', 'git', 'Triager', 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', $2, true)`,
    [agentId, path.join(installedPath, "maister-agents", "triager.md")],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id")
     VALUES ($1, $2, $3)`,
    [randomUUID(), agentId, projectId],
  );

  return agentId;
}

async function runBrainContext(runId: string): Promise<boolean | null> {
  const res = await pool.query(
    `SELECT "brain_context" FROM "runs" WHERE "id" = $1`,
    [runId],
  );

  return res.rows[0].brain_context as boolean | null;
}

describe("ADR-122 run-launch brain_context persistence (T5.3)", () => {
  it("persists runs.brain_context = true when the launch opts in", async () => {
    const agentId = await seedAgent();

    const result = await launchAgentRun({
      agentId,
      projectId,
      trigger: { source: "manual" },
      brainContext: true,
      db,
    });

    if ("deduped" in result) throw new Error("unexpected dedup");

    expect(await runBrainContext(result.runId)).toBe(true);
  });

  it("persists NULL (inherit) when the launch omits the option", async () => {
    const agentId = await seedAgent();

    const result = await launchAgentRun({
      agentId,
      projectId,
      trigger: { source: "manual" },
      db,
    });

    if ("deduped" in result) throw new Error("unexpected dedup");

    // null = inherit the flow/agent default at ambient-inject time (defaults
    // OFF in Sub-project A) — NOT false, so a later default flip is honored.
    expect(await runBrainContext(result.runId)).toBeNull();
  });
});

describe("ADR-122 per-link brain axes (T5.3)", () => {
  it("sets can_read_brain + can_write_brain, and the view reflects them", async () => {
    const agentId = await seedAgent();

    await updateAgentLink(
      {
        projectId,
        agentId,
        patch: { canReadBrain: true, canWriteBrain: true },
      },
      db,
    );

    const row = await pool.query(
      `SELECT "can_read_brain", "can_write_brain" FROM "agent_project_links"
       WHERE "agent_id" = $1 AND "project_id" = $2`,
      [agentId, projectId],
    );

    expect(row.rows[0].can_read_brain).toBe(true);
    expect(row.rows[0].can_write_brain).toBe(true);

    const view = await getProjectAgentsView(projectId, db);
    const attached = view.attached.find((a) => a.agent.id === agentId);

    expect(attached?.canReadBrain).toBe(true);
    expect(attached?.canWriteBrain).toBe(true);
  });

  it("read and write axes are independent (turning read off leaves write on)", async () => {
    const agentId = await seedAgent();

    await updateAgentLink(
      {
        projectId,
        agentId,
        patch: { canReadBrain: true, canWriteBrain: true },
      },
      db,
    );
    // Read alone never grants write, and clearing read must not clear write.
    await updateAgentLink(
      { projectId, agentId, patch: { canReadBrain: false } },
      db,
    );

    const view = await getProjectAgentsView(projectId, db);
    const attached = view.attached.find((a) => a.agent.id === agentId);

    expect(attached?.canReadBrain).toBe(false);
    expect(attached?.canWriteBrain).toBe(true);
  });

  it("defaults both axes to false for a freshly attached link", async () => {
    const agentId = await seedAgent();

    const view = await getProjectAgentsView(projectId, db);
    const attached = view.attached.find((a) => a.agent.id === agentId);

    expect(attached?.canReadBrain).toBe(false);
    expect(attached?.canWriteBrain).toBe(false);
  });
});
