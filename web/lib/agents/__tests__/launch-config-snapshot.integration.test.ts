// ADR-110 (D5): the agent config is resolved ONCE at launch and snapshotted
// onto runs.agent_config. The prompt injection reads THAT snapshot, never
// re-resolving from the (mutable) agent_project_links.config — so mutating the
// instance config AFTER spawn changes neither the snapshot nor the injected
// block. Driven end-to-end through launchAgentRun with tryStartRun stubbed (no
// supervisor session spawns) against a real Postgres.

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
let buildAgentPrompt: typeof import("@/lib/agents/launch").buildAgentPrompt;

beforeAll(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "maister-cfg-cache-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ launchAgentRun, buildAgentPrompt } = await import("@/lib/agents/launch"));
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
  worktreesTmp = await mkdtemp(path.join(os.homedir(), ".maister-cfg-wt-"));
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
     VALUES ($1, $2, 'P', '/tmp/cfg-repo', 'main', 'maister/', '/tmp/maister.yaml', $3, 1)`,
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

const CONFIG_BLOCK = [
  "config:",
  "  - key: detect_duplicates",
  "    type: boolean",
  "    default: true",
  "  - key: intake_mode",
  "    type: enum",
  "    values:",
  "      - triage_only",
  "      - clarify",
  "    default: clarify",
  "",
].join("\n");

// A workspace:none agent whose .md declares config, attached+trusted, with an
// agent_project_links row carrying the instance config override.
async function seedTriager(
  instanceConfig: Record<string, unknown> | null,
): Promise<string> {
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
${CONFIG_BLOCK}---
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
    `INSERT INTO "agents" ("id", "package_name", "version_label", "origin", "name", "description", "workspace", "mode", "triggers", "risk_tier", "config_schema", "source_path", "enabled")
     VALUES ($1, 'aif', 'v1.0.0', 'git', 'Triager', 'd', 'none', 'session', '["manual"]'::jsonb, 'read_only', $2::jsonb, $3, true)`,
    [
      agentId,
      JSON.stringify([
        { key: "detect_duplicates", type: "boolean", default: true },
        {
          key: "intake_mode",
          type: "enum",
          values: ["triage_only", "clarify"],
          default: "clarify",
        },
      ]),
      path.join(installedPath, "maister-agents", "triager.md"),
    ],
  );
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id", "config")
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      randomUUID(),
      agentId,
      projectId,
      instanceConfig === null ? null : JSON.stringify(instanceConfig),
    ],
  );

  return agentId;
}

async function runAgentConfig(
  runId: string,
): Promise<Record<string, unknown> | null> {
  const res = await pool.query(
    `SELECT "agent_config" FROM "runs" WHERE "id" = $1`,
    [runId],
  );

  return res.rows[0].agent_config as Record<string, unknown> | null;
}

describe("ADR-110 launch-time config snapshot", () => {
  it("persists runs.agent_config = resolved (instance over declared default)", async () => {
    const agentId = await seedTriager({ intake_mode: "triage_only" });

    const result = await launchAgentRun({
      agentId,
      projectId,
      trigger: { source: "manual" },
      db,
    });

    if ("deduped" in result) throw new Error("unexpected dedup");

    // intake_mode overridden by the instance; detect_duplicates is the default.
    expect(await runAgentConfig(result.runId)).toEqual({
      detect_duplicates: true,
      intake_mode: "triage_only",
    });
  });

  it("a null instance snapshots all declared defaults", async () => {
    const agentId = await seedTriager(null);

    const result = await launchAgentRun({
      agentId,
      projectId,
      trigger: { source: "manual" },
      db,
    });

    if ("deduped" in result) throw new Error("unexpected dedup");

    expect(await runAgentConfig(result.runId)).toEqual({
      detect_duplicates: true,
      intake_mode: "clarify",
    });
  });

  it("mutating agent_project_links.config AFTER spawn changes neither the snapshot nor the injected block", async () => {
    const agentId = await seedTriager({ intake_mode: "triage_only" });

    const result = await launchAgentRun({
      agentId,
      projectId,
      trigger: { source: "manual" },
      db,
    });

    if ("deduped" in result) throw new Error("unexpected dedup");

    const snapshotBefore = await runAgentConfig(result.runId);

    // Mutate the instance config to the opposite value AFTER the run launched.
    await pool.query(
      `UPDATE "agent_project_links" SET "config" = $1::jsonb WHERE "agent_id" = $2 AND "project_id" = $3`,
      [JSON.stringify({ intake_mode: "clarify" }), agentId, projectId],
    );

    // The persisted snapshot is unchanged by the post-launch mutation.
    expect(await runAgentConfig(result.runId)).toEqual(snapshotBefore);
    expect(snapshotBefore).toEqual({
      detect_duplicates: true,
      intake_mode: "triage_only",
    });

    // The prompt built from the persisted run reads the snapshot — still the
    // original value, NOT the mutated instance value.
    const runRows = await (db as any)
      .select()
      .from((await import("@/lib/db/schema")).runs)
      .where(
        (await import("drizzle-orm")).eq(
          (await import("@/lib/db/schema")).runs.id,
          result.runId,
        ),
      );
    const { resolveEffectiveAgentDefinition } = await import(
      "@/lib/agents/effective"
    );
    const effective = await resolveEffectiveAgentDefinition(
      { agentId, projectId },
      db,
    );
    const prompt = await buildAgentPrompt(db, effective.parsed, runRows[0]);

    expect(prompt).toContain("Effective configuration");
    expect(prompt).toContain("triage_only");
    expect(prompt).not.toContain("clarify");
  });
});
