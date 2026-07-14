// ADR-111 (D5): the agent config is resolved ONCE at launch and snapshotted
// onto runs.agent_config. The prompt injection reads THAT snapshot, never
// re-resolving from the (mutable) agent_project_links.config — so mutating the
// instance config AFTER spawn changes neither the snapshot nor the injected
// block. Driven end-to-end through launchAgentRun with tryStartRun stubbed (no
// supervisor session spawns) against a real Postgres.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
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
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

vi.mock("@/lib/scheduler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler")>();

  return {
    ...actual,
    tryStartRun: vi.fn(async () => ({ started: false, queuePosition: 1 })),
  };
});

let testDatabase: StartedPostgresTestDb;
let pool: Pool;
let db: NodePgDatabase;
let cacheRoot: string;
let worktreesTmp: string;
let originalWorktreesRoot: string | undefined;

let launchAgentRun: typeof import("@/lib/agents/launch").launchAgentRun;
let buildAgentPrompt: typeof import("@/lib/agents/launch").buildAgentPrompt;

beforeAll(async () => {
  cacheRoot = await mkdtemp(path.join(os.tmpdir(), "maister-cfg-cache-"));

  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });

  pool = testDatabase.pool;
  db = testDatabase.db;

  ({ launchAgentRun, buildAgentPrompt } = await import("@/lib/agents/launch"));
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
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

describe("ADR-111 launch-time config snapshot", () => {
  it("supersedes every open agent question only after the new task-bound standalone run is durable", async () => {
    const agentId = await seedTriager(null);
    const schema = await import("@/lib/db/schema");
    const taskId = randomUUID();
    const sourceRunId = randomUUID();
    const hitlRequestId = randomUUID();

    await db.insert(schema.tasks).values({
      id: taskId,
      projectId,
      number: 1,
      title: "Clarify deployment target",
      prompt: "Deploy the service",
    });
    await db.insert(schema.runs).values({
      id: sourceRunId,
      runKind: "agent",
      projectId,
      taskId,
      agentId,
      status: "Done",
      flowVersion: "agent",
      flowRevision: "manual",
      agentWorkspace: "none",
    });
    await db.insert(schema.hitlRequests).values({
      id: hitlRequestId,
      runId: sourceRunId,
      stepId: "agent",
      kind: "agent_question",
      taskId,
      activationState: "active",
      reTriggerMode: "agent",
      prompt: "Which deployment target should be used?",
      schema: {
        schemaVersion: 1,
        fields: [
          {
            name: "target",
            type: "enum",
            required: true,
            options: ["staging", "production"],
          },
        ],
      },
    });
    await db.insert(schema.taskClarifications).values({
      id: randomUUID(),
      taskId,
      seq: 1,
      sourceHitlRequestId: hitlRequestId,
      originRunId: sourceRunId,
      originAgentId: agentId,
      question: "Which deployment target should be used?",
      questionSchema: {
        schemaVersion: 1,
        fields: [
          {
            name: "target",
            type: "enum",
            required: true,
            options: ["staging", "production"],
          },
        ],
      },
      reTriggerMode: "agent",
    });
    await db.insert(schema.assignments).values({
      id: randomUUID(),
      projectId,
      runId: sourceRunId,
      taskId,
      hitlRequestId,
      actionKind: "agent_question",
      title: "Agent clarification required",
    });

    const result = await launchAgentRun({
      agentId,
      projectId,
      taskId,
      trigger: { source: "manual" },
      db,
    });

    if ("deduped" in result) throw new Error("unexpected dedup");

    const [question] = await db
      .select({
        supersededAt: schema.hitlRequests.supersededAt,
        supersededByRunId: schema.hitlRequests.supersededByRunId,
      })
      .from(schema.hitlRequests)
      .where(
        (await import("drizzle-orm")).eq(schema.hitlRequests.id, hitlRequestId),
      );
    const [assignment] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(
        (await import("drizzle-orm")).eq(
          schema.assignments.hitlRequestId,
          hitlRequestId,
        ),
      );
    const [successor] = await db
      .select({ id: schema.runs.id, taskId: schema.runs.taskId })
      .from(schema.runs)
      .where((await import("drizzle-orm")).eq(schema.runs.id, result.runId));

    expect(successor).toEqual({ id: result.runId, taskId });
    expect(question?.supersededAt).toBeInstanceOf(Date);
    expect(question?.supersededByRunId).toBe(result.runId);
    expect(assignment?.status).toBe("cancelled");
  });

  it("rolls back the successor when superseding an active question fails", async () => {
    const agentId = await seedTriager(null);
    const schema = await import("@/lib/db/schema");
    const taskId = randomUUID();
    const sourceRunId = randomUUID();
    const hitlRequestId = randomUUID();

    await db.insert(schema.tasks).values({
      id: taskId,
      projectId,
      number: 1,
      title: "Clarify deployment target",
      prompt: "Deploy the service",
    });
    await db.insert(schema.runs).values({
      id: sourceRunId,
      runKind: "agent",
      projectId,
      taskId,
      agentId,
      status: "Done",
      flowVersion: "agent",
      flowRevision: "manual",
      agentWorkspace: "none",
    });
    await db.insert(schema.hitlRequests).values({
      id: hitlRequestId,
      runId: sourceRunId,
      stepId: "agent",
      kind: "agent_question",
      taskId,
      activationState: "active",
      reTriggerMode: "agent",
      prompt: "Which deployment target should be used?",
      schema: {
        schemaVersion: 1,
        fields: [
          {
            name: "target",
            type: "enum",
            required: true,
            options: ["staging", "production"],
          },
        ],
      },
    });
    await db.insert(schema.taskClarifications).values({
      id: randomUUID(),
      taskId,
      seq: 1,
      sourceHitlRequestId: hitlRequestId,
      originRunId: sourceRunId,
      originAgentId: agentId,
      question: "Which deployment target should be used?",
      questionSchema: {
        schemaVersion: 1,
        fields: [
          {
            name: "target",
            type: "enum",
            required: true,
            options: ["staging", "production"],
          },
        ],
      },
      reTriggerMode: "agent",
    });
    await db.insert(schema.assignments).values({
      id: randomUUID(),
      projectId,
      runId: sourceRunId,
      taskId,
      hitlRequestId,
      actionKind: "agent_question",
      title: "Agent clarification required",
    });

    await pool.query(`
      CREATE FUNCTION raise_agent_question_supersession() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced agent-question supersession failure';
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER raise_agent_question_supersession
      BEFORE UPDATE OF superseded_at ON hitl_requests
      FOR EACH ROW
      WHEN (NEW.kind = 'agent_question')
      EXECUTE FUNCTION raise_agent_question_supersession()
    `);

    try {
      await expect(
        launchAgentRun({
          agentId,
          projectId,
          taskId,
          trigger: { source: "manual" },
          db,
        }),
      ).rejects.toThrow("forced agent-question supersession failure");
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS raise_agent_question_supersession ON hitl_requests",
      );
      await pool.query(
        "DROP FUNCTION IF EXISTS raise_agent_question_supersession()",
      );
    }

    const successors = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(
        (await import("drizzle-orm")).and(
          (await import("drizzle-orm")).eq(schema.runs.taskId, taskId),
          (await import("drizzle-orm")).ne(schema.runs.id, sourceRunId),
        ),
      );
    const [question] = await db
      .select({ supersededAt: schema.hitlRequests.supersededAt })
      .from(schema.hitlRequests)
      .where(
        (await import("drizzle-orm")).eq(schema.hitlRequests.id, hitlRequestId),
      );
    const [assignment] = await db
      .select({ status: schema.assignments.status })
      .from(schema.assignments)
      .where(
        (await import("drizzle-orm")).eq(
          schema.assignments.hitlRequestId,
          hitlRequestId,
        ),
      );

    expect(successors).toEqual([]);
    expect(question?.supersededAt).toBeNull();
    expect(assignment?.status).toBe("open");
  });

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
