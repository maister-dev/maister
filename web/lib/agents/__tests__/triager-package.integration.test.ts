// Phase 5 / T5.2 (ADR-112): the core package register -> attach -> launch path
// for the Triager, end-to-end against a real Postgres. Proves:
//   - a FLOW-LESS package (no flows[] in the manifest) registers its
//     maister-agents/*.md through the real registerPackageAgents/resyncAgents,
//     projecting agents.config_schema from the shipped triager.md;
//   - attaching + linking it (the event binding seeded from recommended) and
//     launching it snapshots runs.agent_config and injects the effective config
//     into the prompt;
//   - the trust/enable contour refuses a launch while the package is untrusted
//     or the agent is disabled (PRECONDITION).
//
// The shipped definition is read from the maister-repo fixture (byte-identical
// to the maister-plugins core package), so the test needs no sibling repo.
// tryStartRun is stubbed: no supervisor session spawns; assertions are on the
// persisted run row + the built prompt.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
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
import { registerPackageAgents, resyncAgents } from "@/lib/agents/registry";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";

const schema = schemaModule as unknown as Record<string, any>;

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
let resolveEffectiveAgentDefinition: typeof import("@/lib/agents/effective").resolveEffectiveAgentDefinition;

// The shipped triager.md (maister-repo fixture == the maister-plugins core pkg).
const TRIAGER_MD_PATH = path.join(
  __dirname,
  "fixtures",
  "core-package",
  "maister-agents",
  "triager.md",
);

const AGENT_ID = "core:triager";

beforeAll(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "maister-core-pkg-"));

  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ launchAgentRun, buildAgentPrompt } = await import("@/lib/agents/launch"));
  ({ resolveEffectiveAgentDefinition } = await import(
    "@/lib/agents/effective"
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
  worktreesTmp = await mkdtemp(path.join(os.homedir(), ".maister-core-wt-"));
  originalWorktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
  process.env.MAISTER_WORKTREES_ROOT = worktreesTmp;

  await pool.query(`DELETE FROM "runs"`);
  await pool.query(`DELETE FROM "agent_schedules"`);
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
     VALUES ($1, $2, 'P', '/tmp/core-repo', 'main', 'maister/', '/tmp/maister.yaml', $3, 1)`,
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

// A real installed-dir fixture for the flow-less core package: copies the
// shipped triager.md into a fresh package root and records the package_installs
// row (manifest has NO flows[] — the flow-less registration case). Returns the
// install id + installed path.
async function installCorePackage(opts?: {
  trustStatus?: string;
  packageStatus?: string;
}): Promise<{ installId: string; installedPath: string }> {
  const installId = randomUUID();
  const installedPath = path.join(cacheRoot, `core-${installId.slice(0, 8)}`);

  await mkdir(path.join(installedPath, "maister-agents"), { recursive: true });
  const triagerMd = await readFile(TRIAGER_MD_PATH, "utf8");

  await writeFile(
    path.join(installedPath, "maister-agents", "triager.md"),
    triagerMd,
    "utf8",
  );

  // A flow-less manifest: spec.flows is empty. registerPackageAgents skips the
  // same-package flow-membership check because the definition declares no flow.
  const manifest = {
    spec: { name: "core", flows: [] },
    inventory: { skills: [], agents: [], platformAgents: ["triager"] },
  };

  await pool.query(
    `INSERT INTO "package_installs"
       ("id", "source_url", "name", "version_label", "resolved_revision",
        "manifest", "manifest_digest", "installed_path", "package_status",
        "trust_status")
     VALUES ($1, 'github.com/maisterhq/maister-plugins', 'core', 'v1.0.0',
             'rev-core-1', $2::jsonb, 'digest', $3, $4, $5)`,
    [
      installId,
      JSON.stringify(manifest),
      installedPath,
      opts?.packageStatus ?? "Installed",
      opts?.trustStatus ?? "trusted",
    ],
  );

  return { installId, installedPath };
}

async function attachCorePackage(packageInstallId: string): Promise<void> {
  await pool.query(
    `INSERT INTO "project_package_attachments"
       ("id", "project_id", "package_install_id", "package_name")
     VALUES ($1, $2, $3, 'core')`,
    [randomUUID(), projectId, packageInstallId],
  );
}

// The per-project link + the recommended event binding (recommended.events ->
// an agent_schedules event row, as the attach panel seeds). instanceConfig is
// the per-instance agent_project_links.config override (null => all defaults).
async function linkAndBindFromRecommended(
  instanceConfig: Record<string, unknown> | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO "agent_project_links" ("id", "agent_id", "project_id", "enabled", "config")
     VALUES ($1, $2, $3, true, $4::jsonb)`,
    [
      randomUUID(),
      AGENT_ID,
      projectId,
      instanceConfig === null ? null : JSON.stringify(instanceConfig),
    ],
  );

  // Seed the trigger binding from the definition's recommended.events.
  const recommendedEvents = [
    "task.created",
    "task.triage_requeued",
    "task.comment_added",
  ];

  await pool.query(
    `INSERT INTO "agent_schedules" ("id", "agent_id", "project_id", "trigger_type", "event_match", "enabled")
     VALUES ($1, $2, $3, 'event', $4::jsonb, true)`,
    [
      randomUUID(),
      AGENT_ID,
      projectId,
      JSON.stringify({ kinds: recommendedEvents }),
    ],
  );
}

async function agentRow(): Promise<Record<string, unknown> | undefined> {
  const rows = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, AGENT_ID));

  return rows[0] as Record<string, unknown> | undefined;
}

const DECLARED_CONFIG = [
  {
    key: "auto_enqueue",
    type: "enum",
    values: ["off", "when_confident", "always"],
    default: "off",
    label: "Auto-enqueue after triage",
    description: expect.any(String),
  },
  {
    key: "detect_duplicates",
    type: "boolean",
    default: true,
    label: "Detect duplicates",
    description: expect.any(String),
  },
  {
    key: "intake_mode",
    type: "enum",
    values: ["triage_only", "clarify"],
    default: "clarify",
    label: "Intake mode",
    description: expect.any(String),
  },
];

describe("core package register -> attach -> launch (T5.2)", () => {
  it("registers the flow-less core package and projects config_schema from triager.md", async () => {
    const { installId } = await installCorePackage();

    const summary = await registerPackageAgents(installId, db);

    expect(summary.registered).toEqual([AGENT_ID]);
    expect(summary.invalid).toEqual([]);

    const row = await agentRow();

    expect(row).toMatchObject({
      id: AGENT_ID,
      packageName: "core",
      name: "Triager",
      workspace: "none",
      mode: "session",
      riskTier: "read_only",
      enabled: true,
      // Flow-less: no same-package flow membership, so flowRef stays null.
      flowRef: null,
    });
    // The declared config block is projected verbatim into config_schema.
    expect(row?.configSchema).toEqual(DECLARED_CONFIG);
  });

  it("resyncAgents projects the same flow-less package idempotently", async () => {
    const { installId } = await installCorePackage();

    const summary = await resyncAgents(db);

    expect(summary.invalid).toEqual([]);
    expect(summary.missing).toEqual([]);
    expect(summary.synced).toBeGreaterThanOrEqual(1);
    expect((await agentRow())?.configSchema).toEqual(DECLARED_CONFIG);

    // The packageInstallId is the registration anchor for the launch tests.
    expect(installId).toBeTruthy();
  });

  it("launches the attached triager, snapshotting agent_config and injecting it into the prompt", async () => {
    const { installId } = await installCorePackage();

    await registerPackageAgents(installId, db);
    await attachCorePackage(installId);
    // The instance overrides intake_mode; the other two keep their defaults.
    await linkAndBindFromRecommended({ intake_mode: "triage_only" });

    const result = await launchAgentRun({
      agentId: AGENT_ID,
      projectId,
      trigger: { source: "manual" },
      db,
    });

    if ("deduped" in result) throw new Error("unexpected dedup");
    expect(result.status).toBe("Pending"); // tryStartRun stubbed -> queued

    // The snapshot is the resolved effective config (instance over default).
    const runConfig = (
      await pool.query(`SELECT "agent_config" FROM "runs" WHERE "id" = $1`, [
        result.runId,
      ])
    ).rows[0].agent_config as Record<string, unknown> | null;

    expect(runConfig).toEqual({
      auto_enqueue: "off",
      detect_duplicates: true,
      intake_mode: "triage_only",
    });

    // The prompt injects the "Effective configuration" block from the snapshot.
    const runRows = await (db as any)
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, result.runId));
    const effective = await resolveEffectiveAgentDefinition(
      { agentId: AGENT_ID, projectId },
      db,
    );
    const prompt = await buildAgentPrompt(db, effective.parsed, runRows[0]);

    expect(prompt).toContain("Effective configuration");
    expect(prompt).toContain("triage_only");
    // The persona body is present too.
    expect(prompt).toContain("Triager");
  });

  it("refuses to launch while the core package is untrusted (PRECONDITION)", async () => {
    const { installId } = await installCorePackage({
      trustStatus: "untrusted",
    });

    await registerPackageAgents(installId, db);
    await attachCorePackage(installId);
    await linkAndBindFromRecommended(null);

    await expect(
      launchAgentRun({
        agentId: AGENT_ID,
        projectId,
        trigger: { source: "manual" },
        db,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "PRECONDITION",
    );

    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM "runs"`)).rows[0].n,
    ).toBe(0);
  });

  it("refuses to launch while the agent is disabled (PRECONDITION)", async () => {
    const { installId } = await installCorePackage();

    await registerPackageAgents(installId, db);
    await attachCorePackage(installId);
    await linkAndBindFromRecommended(null);

    // Disable the catalog row (e.g. a vanished providing package via resync).
    await pool.query(`UPDATE "agents" SET "enabled" = false WHERE "id" = $1`, [
      AGENT_ID,
    ]);

    await expect(
      launchAgentRun({
        agentId: AGENT_ID,
        projectId,
        trigger: { source: "manual" },
        db,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "PRECONDITION",
    );

    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM "runs"`)).rows[0].n,
    ).toBe(0);
  });
});
