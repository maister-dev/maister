/**
 * M27/T-B5 (≡ C8b(1), ADR-069): in-flight immutability — the graph runner
 * materializes the capability set frozen onto `runs.resolved_capability_set` at
 * launch, NOT a live re-resolve. Proof: launch froze `github` at scope
 * flow-package; a higher-precedence `github` then appears at scope project
 * (simulating an edit/publish mid-run). A live resolve would pick the project
 * record (local-first wins); the runner must instead materialize the FROZEN
 * flow-package record.
 *
 * Harness mirrors runner-graph.materialize.integration.test.ts.
 */
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type { SupervisorEvent } from "@/lib/supervisor-client";
import type { ResolvedCapabilitySet } from "@/lib/db/schema";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { runFlow } from "@/lib/flows/runner";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("resolved_snapshot_test")
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

const githubDeclaringFlow = {
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
        enforcement: { mcps: "instruct", tools: "instruct" },
      },
    },
  ],
};

async function seedRun(resolvedCapabilitySet: ResolvedCapabilitySet) {
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
    manifest: githubDeclaringFlow,
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
    flowVersion: "v1.0.0",
    status: "Running",
    resolvedCapabilitySet,
  });
  await db.insert(schema.runSessions).values({
    id: randomUUID(),
    runId,
    sessionName: "default",
    runnerId: executorId,
    capabilityAgent: "claude",
    runnerSnapshot: testRunnerSnapshot(executorId),
  });
  await db.insert(schema.workspaces).values({
    id: randomUUID(),
    runId,
    projectId,
    branch: "feature/test",
    worktreePath,
    parentRepoPath: `/tmp/${slug}`,
  });

  return { runId, projectId, runtimeRoot, worktreePath };
}

// Two `github` MCP records at different scopes with DISTINGUISHABLE material.
// The project record is local-first and would win a LIVE resolve.
async function seedTwoScopeGithub(projectId: string): Promise<void> {
  await db.insert(schema.capabilityRecords).values([
    {
      id: randomUUID(),
      projectId,
      capabilityRefId: "github",
      kind: "mcp",
      label: "GitHub (frozen flow-package)",
      source: "flow-package",
      agents: ["claude", "codex"],
      enforceability: "enforced",
      selectable: true,
      selectedByDefault: false,
      material: {
        command: "frozen-cmd",
        args: [],
        envKeys: ["FROZEN_TOKEN"],
        config: {},
      },
    },
    {
      id: randomUUID(),
      projectId,
      capabilityRefId: "github",
      kind: "mcp",
      label: "GitHub (live project — added mid-run)",
      source: "project",
      agents: ["claude", "codex"],
      enforceability: "enforced",
      selectable: true,
      selectedByDefault: false,
      material: {
        command: "live-cmd",
        args: [],
        envKeys: ["LIVE_TOKEN"],
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
      agents: ["claude", "codex"],
      enforceability: "instructed",
      selectable: true,
      selectedByDefault: false,
      material: {},
    },
  ]);
}

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

describe("runGraph — pins capability materialization to the launch snapshot (T-B5)", () => {
  it("materializes the FROZEN scope's record, not the live local-first winner", async () => {
    const frozen: ResolvedCapabilitySet = {
      flowRevisionId: "rev-x",
      flowOrigin: "git",
      capabilities: [
        { refId: "my-skill", kind: "skill", sha: null, scope: "project" },
      ],
      mcps: [{ refId: "github", sha: null, scope: "flow-package" }],
    };

    const seeded = await seedRun(frozen);

    await seedTwoScopeGithub(seeded.projectId);

    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect(api.createSpy).toHaveBeenCalledTimes(1);

    const arg = api.createSpy.mock.calls[0][0] as {
      mcpServers?: AgentMcpServer[];
    };
    const github = (arg.mcpServers ?? []).find((s) => s.name === "github");

    expect(github).toBeDefined();
    // The launch snapshot froze github@flow-package; the runner must NOT pick up
    // the higher-precedence project record that appeared after launch.
    expect(github?.envKeys).toContain("FROZEN_TOKEN");
    expect(github?.envKeys ?? []).not.toContain("LIVE_TOKEN");
  }, 60_000);
});
