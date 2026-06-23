/**
 * T4.2 + T4.4 (RED) — the graph runner writes a write-once `materialization_plan`
 * to the `node_attempts` ledger for a capability-declaring ai_coding node, and
 * that plan captures the run-start catalog snapshot (resolved revisions).
 *
 * Pins the OBSERVABLE contract only (the persisted node_attempts.materialization_plan
 * jsonb), NOT the runner internals:
 *  (T4.2) After runFlow on a capability-declaring ai_coding node, that node's
 *         node_attempts row has a non-null materializationPlan with profileDigest,
 *         materializedFiles, cleanup.status === "pending", and the capability
 *         refIds grouped into enforcedClasses / instructedClasses / refusedClasses.
 *  (T4.4) The plan's resolvedRevisions carries the run-start snapshot — for a
 *         seeded capability whose revision is "sha-...", the array contains
 *         { refId, kind, sha } mirroring the resolved revision sha.
 *
 * Harness mirrors runner-graph.materialize.integration.test.ts exactly; the only
 * delta is that the seeded capability_records carry explicit `revision` shas and
 * the assertions read node_attempts.materialization_plan instead of the
 * createSession spy args.
 */
import type { NodeAttempt } from "@/lib/db/schema";
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import * as fullSchema from "@/lib/db/schema";
import { capabilityMaterializationRootPath } from "@/lib/capabilities/materialize";
import { runFlow } from "@/lib/flows/runner";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("matplan_test")
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

type Seeded = {
  runId: string;
  projectId: string;
  executorId: string;
  runtimeRoot: string;
  worktreePath: string;
};

async function seedGraphRun(manifest: unknown): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({
    taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "g",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/g",
    manifest,
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Math.trunc(Math.random() * 1e9) + 1,
    id: taskId,
    projectId,
    title: "t",
    prompt: "p",
    flowId,
  });
  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
    flowVersion: "v1.0.0",
    status: "Running",
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, projectId, executorId, runtimeRoot, worktreePath };
}

// Seed the capability_records the node opts into via its settings, carrying
// explicit `revision` shas so the run-start snapshot (T4.4) is observable in the
// persisted plan's resolvedRevisions. github is ENFORCED mcp; my-skill is an
// INSTRUCTED skill — neither is refused, so the resolver does not throw.
async function seedCapabilityRecords(projectId: string): Promise<void> {
  await db.insert(schema.capabilityRecords).values([
    {
      id: randomUUID(),
      projectId,
      capabilityRefId: "github",
      kind: "mcp",
      label: "GitHub MCP",
      source: "project",
      revision: "sha-github-1111",
      agents: ["claude", "codex"],
      enforceability: "enforced",
      selectable: true,
      selectedByDefault: false,
      material: {
        command: "github-mcp",
        args: [],
        envKeys: ["GITHUB_TOKEN"],
        config: {},
      },
    },
    {
      id: randomUUID(),
      projectId,
      capabilityRefId: "my-skill",
      kind: "skill",
      label: "My Skill",
      source: "project",
      revision: "sha-skill-2222",
      agents: ["claude", "codex"],
      enforceability: "instructed",
      selectable: true,
      selectedByDefault: false,
      material: {},
    },
  ]);
}

async function getAttempts(runId: string): Promise<NodeAttempt[]> {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as NodeAttempt[];
}

// A SupervisorApi spy. createSession returns a canned session and streamSession
// yields a clean end-turn so the ai_coding node finishes without a real agent.
function makeSupervisorSpy(): SupervisorApi & {
  createSpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn(async () => ({
    sessionId: "sup-1",
    pid: 1,
    acpSessionId: "acp-1",
  }));

  async function* endTurnStream(): AsyncGenerator<SupervisorEvent> {
    yield {
      type: "session.exited",
      sessionId: "sup-1",
      monotonicId: 1,
      exitCode: 0,
    } as SupervisorEvent;
  }

  return {
    createSession: createSpy as unknown as SupervisorApi["createSession"],
    deleteSession: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
    streamSession: vi.fn(() =>
      endTurnStream(),
    ) as unknown as SupervisorApi["streamSession"],
    cancelPermission: vi.fn(
      async () => ({ ok: true }) as { ok: true },
    ) as unknown as SupervisorApi["cancelPermission"],
    checkpointSession: async () => ({
      alreadyCheckpointed: false,
      sessionId: "s",
      monotonicId: 0,
    }),
    deliverPermission: vi.fn(
      async () => ({ ok: true }) as { ok: true },
    ) as unknown as SupervisorApi["deliverPermission"],
    createSpy,
  };
}

// ai_coding node that opts into capabilities: declares mcps + skills (matching
// the seeded records) and a tools.claude allow-list + permissionMode. instruct
// enforcement keeps the M11c gate happy so the spawn path is reached.
const capabilityDeclaringFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: {
        mcps: ["github"],
        skills: ["my-skill"],
        tools: { claude: ["Read"] },
        permissionMode: "ask",
        enforcement: { mcps: "instruct" },
      },
    },
  ],
};

// Seed an extra INSTRUCTED skill whose `agents` array excludes the run's claude
// executor → under a claude executor it is unsupported + optional, so the
// resolver pushes it to `downgraded` AND `instructed` but NOT to `supported`.
// The plan must NOT list a silently-dropped capability as instructed nor in the
// run-start resolvedRevisions snapshot.
async function seedDowngradedSkill(projectId: string): Promise<void> {
  await db.insert(schema.capabilityRecords).values({
    id: randomUUID(),
    projectId,
    capabilityRefId: "codex-only-skill",
    kind: "skill",
    label: "Codex Only Skill",
    source: "project",
    revision: "sha-codex-9999",
    agents: ["codex"],
    enforceability: "instructed",
    selectable: true,
    selectedByDefault: false,
    material: {},
  });
}

// Same as capabilityDeclaringFlow but the node also opts into the codex-only
// skill — unsupported under the claude executor → downgraded (silently dropped).
const downgradeDeclaringFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: {
        mcps: ["github"],
        skills: ["my-skill", "codex-only-skill"],
        tools: { claude: ["Read"] },
        permissionMode: "ask",
        enforcement: { mcps: "instruct" },
      },
    },
  ],
};

describe("runGraph — materialization plan → node_attempts ledger (T4.2 / T4.4)", () => {
  it("writes a write-once materialization_plan to the node's node_attempts row (T4.2)", async () => {
    const seeded = await seedGraphRun(capabilityDeclaringFlow);

    await seedCapabilityRecords(seeded.projectId);

    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    // Sanity: the spawn path was reached (every declared class resolves to
    // instructed, so the M11c gate did NOT refuse), so createSession ran once
    // for the single ai_coding node. The contract is on the durable plan.
    expect(api.createSpy).toHaveBeenCalledTimes(1);

    const attempts = await getAttempts(seeded.runId);
    const attempt = attempts.find((a) => a.nodeId === "implement");

    expect(attempt).toBeDefined();

    const plan = attempt!.materializationPlan;

    // T4.2: the plan is persisted (non-null) on the capability-declaring node.
    expect(plan).not.toBeNull();
    expect(plan).toBeDefined();

    // profileDigest is a non-empty string (equal to the resolved profile digest).
    expect(typeof plan!.profileDigest).toBe("string");
    expect(plan!.profileDigest.length).toBeGreaterThan(0);

    // materializedFiles: the written settings.json/.mcp.json paths.
    expect(Array.isArray(plan!.materializedFiles)).toBe(true);
    expect(plan!.materializedFiles.length).toBeGreaterThan(0);

    // cleanup is seeded `pending` at materialize time (T4.3 mutates it later).
    expect(plan!.cleanup.status).toBe("pending");

    // Capability refIds grouped by disposition. ENFORCED mcp github →
    // enforcedClasses; INSTRUCTED skill my-skill → instructedClasses; a refused
    // enforced cap would have made the resolver throw, so refusedClasses is [].
    expect(plan!.enforcedClasses).toContain("github");
    expect(plan!.instructedClasses).toContain("my-skill");
    expect(plan!.refusedClasses).toEqual([]);

    // ACP runner migration: profile.json records the durable resolved launch
    // identity. This legacy fixture has no runner_id, so the fallback identity
    // is the executor row id.
    const profileJson = JSON.parse(
      await readFile(
        join(
          capabilityMaterializationRootPath(
            seeded.worktreePath,
            seeded.runId,
            attempt!.id,
          ),
          "profile.json",
        ),
        "utf8",
      ),
    );

    expect(profileJson.executor.executorRefId).toBe(seeded.executorId);
  }, 60_000);

  it("captures the run-start resolved-revision snapshot in the plan (T4.4)", async () => {
    const seeded = await seedGraphRun(capabilityDeclaringFlow);

    await seedCapabilityRecords(seeded.projectId);

    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    const attempts = await getAttempts(seeded.runId);
    const attempt = attempts.find((a) => a.nodeId === "implement");

    expect(attempt).toBeDefined();

    const plan = attempt!.materializationPlan;

    expect(plan).not.toBeNull();

    // T4.4: each resolved capability's revision sha was snapshotted into the
    // durable plan at run start (proving the catalog snapshot, not a live read).
    expect(plan!.resolvedRevisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          refId: "github",
          kind: "mcp",
          sha: "sha-github-1111",
        }),
        expect.objectContaining({
          refId: "my-skill",
          kind: "skill",
          sha: "sha-skill-2222",
        }),
      ]),
    );
  }, 60_000);

  it("excludes downgraded (silently-dropped) capabilities from instructedClasses and resolvedRevisions", async () => {
    const seeded = await seedGraphRun(downgradeDeclaringFlow);

    await seedCapabilityRecords(seeded.projectId);
    await seedDowngradedSkill(seeded.projectId);

    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    const attempts = await getAttempts(seeded.runId);
    const attempt = attempts.find((a) => a.nodeId === "implement");

    expect(attempt).toBeDefined();

    const plan = attempt!.materializationPlan;

    expect(plan).not.toBeNull();

    // The supported instructed skill is listed; the downgraded codex-only skill
    // (unsupported under the claude executor) is NOT — it was silently dropped,
    // so listing it as "instructed" would be a misleading immutable audit.
    expect(plan!.instructedClasses).toContain("my-skill");
    expect(plan!.instructedClasses).not.toContain("codex-only-skill");

    // The downgraded cap is not in `supported`, so its revision sha never made
    // it into the run-start snapshot either.
    expect(plan!.resolvedRevisions).not.toContainEqual(
      expect.objectContaining({ refId: "codex-only-skill" }),
    );
  }, 60_000);

  it("never persists a capability secret VALUE into the materialization_plan ledger (R-SECRET)", async () => {
    const SECRET = "ghp_MATPLAN_LEDGER_SECRET_xyz";
    const seeded = await seedGraphRun(capabilityDeclaringFlow);

    // github's material carries a literal secret in its `config` blob (arbitrary
    // user YAML) — neither the value nor the config must reach the durable plan.
    await db.insert(schema.capabilityRecords).values([
      {
        id: randomUUID(),
        projectId: seeded.projectId,
        capabilityRefId: "github",
        kind: "mcp",
        label: "GitHub MCP",
        source: "project",
        revision: "sha-github-1111",
        agents: ["claude", "codex"],
        enforceability: "enforced",
        selectable: true,
        selectedByDefault: false,
        material: {
          command: "github-mcp",
          args: [],
          envKeys: ["GITHUB_TOKEN"],
          config: { token: SECRET },
        },
      },
      {
        id: randomUUID(),
        projectId: seeded.projectId,
        capabilityRefId: "my-skill",
        kind: "skill",
        label: "My Skill",
        source: "project",
        revision: "sha-skill-2222",
        agents: ["claude", "codex"],
        enforceability: "instructed",
        selectable: true,
        selectedByDefault: false,
        material: {},
      },
    ]);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeSupervisorSpy(),
    });

    // Re-read the persisted plan jsonb straight from the DB and grep it: the plan
    // carries refIds / shas / class-names / paths — NEVER material or secrets.
    const attempts = await getAttempts(seeded.runId);
    const plan = attempts.find(
      (a) => a.nodeId === "implement",
    )!.materializationPlan;

    expect(plan).not.toBeNull();
    expect(JSON.stringify(plan)).not.toContain(SECRET);
    // The structural ref IS recorded (proving the plan was actually built).
    expect(plan!.resolvedRevisions.some((r) => r.refId === "github")).toBe(
      true,
    );
  }, 60_000);
});
