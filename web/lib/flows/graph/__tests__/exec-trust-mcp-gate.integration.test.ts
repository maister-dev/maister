/**
 * M27/T-C8b(3) (ADR-068/§4.2 two-axis trust, mcp-management.md §6.2): the graph
 * runner withholds an MCP `stdio` server (local command spawn) unless the run's
 * pinned `flow_revisions.exec_trust` is `trusted`. Proof: the SAME run + stdio
 * github MCP materializes the server only when the owning revision is
 * exec-trusted; an untrusted revision hands NO stdio server to createSession.
 *
 * Harness mirrors runner-graph.materialize.integration.test.ts, plus a pinned
 * flow_revisions row carrying the exec_trust axis.
 */
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type { SupervisorEvent } from "@/lib/supervisor-client";
import type { FlowRevisionExecTrust } from "@/lib/db/schema";

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
    .withDatabase("exec_trust_mcp_test")
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

const stdioMcpFlow = {
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
        tools: { claude: ["Read"] },
        permissionMode: "ask",
        enforcement: { mcps: "instruct", tools: "instruct" },
      },
    },
  ],
};

async function seedRun(execTrust: FlowRevisionExecTrust) {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const revisionId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));
  const installedPath = await mkdtemp(join(tmpdir(), "rev-"));
  // Unique per call: avoid (flow_ref_id, resolved_revision) collisions between
  // the two cases sharing one container. 40-char lowercase hex.
  const flowRef = `g-${revisionId.slice(0, 8)}`;
  const sha = (revisionId.replace(/-/g, "") + "0".repeat(8)).slice(0, 40);

  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flowRevisions).values({
    id: revisionId,
    flowRefId: flowRef,
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: sha,
    manifestDigest: `digest-${revisionId}`,
    manifest: stdioMcpFlow,
    schemaVersion: 1,
    installedPath,
    setupStatus: "not_required",
    packageStatus: "Installed",
    execTrust,
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: flowRef,
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath,
    manifest: stdioMcpFlow,
    schemaVersion: 1,
    enabledRevisionId: revisionId,
  });
  await db.insert(schema.tasks).values({ number: Math.trunc(Math.random() * 1e9) + 1,
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
    flowRevision: sha,
    flowRevisionId: revisionId,
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
  await db.insert(schema.capabilityRecords).values({
    id: randomUUID(),
    projectId,
    capabilityRefId: "github",
    kind: "mcp",
    label: "GitHub MCP (stdio)",
    source: "project",
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
  });

  return { runId, runtimeRoot };
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
    deliverPermission: vi.fn(
      async () => ({ ok: true }) as { ok: true },
    ) as unknown as SupervisorApi["deliverPermission"],
    createSpy,
  };
}

function githubFromCreateCall(api: { createSpy: ReturnType<typeof vi.fn> }) {
  const arg = api.createSpy.mock.calls[0][0] as {
    mcpServers?: AgentMcpServer[];
  };

  return (arg.mcpServers ?? []).find((s) => s.name === "github");
}

describe("runGraph — stdio MCP spawn gated on flow_revisions.exec_trust (T-C8b)", () => {
  it("withholds the stdio MCP when the pinned revision is untrusted", async () => {
    const seeded = await seedRun("untrusted");
    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect(api.createSpy).toHaveBeenCalledTimes(1);
    expect(githubFromCreateCall(api)).toBeUndefined();
  }, 60_000);

  it("materializes the stdio MCP when the pinned revision is trusted", async () => {
    const seeded = await seedRun("trusted");
    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect(api.createSpy).toHaveBeenCalledTimes(1);

    const github = githubFromCreateCall(api);

    expect(github).toBeDefined();
    expect(github?.transport).toBe("stdio");
    expect(github?.envKeys).toContain("GITHUB_TOKEN");
  }, 60_000);
});
