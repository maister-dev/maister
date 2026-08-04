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

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runFlow } from "@/lib/flows/runner";
import { schema, seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "exec_trust_mcp_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
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
  const installedPath = await mkdtemp(join(tmpdir(), "rev-"));
  // Unique per call: avoid (flow_ref_id, resolved_revision) collisions between
  // the two cases sharing one container. 40-char lowercase hex.
  const unique = randomUUID();
  const flowRef = `g-${unique.slice(0, 8)}`;
  const sha = (unique.replace(/-/g, "") + "0".repeat(8)).slice(0, 40);

  const seeded = await seedGraphRun(db, stdioMcpFlow, {
    flowRefId: flowRef,
    installedPath,
    flowRevision: { execTrust, resolvedRevision: sha, enabledOnFlow: true },
    run: { flowRevision: sha },
  });

  await db.insert(schema.capabilityRecords).values({
    id: randomUUID(),
    projectId: seeded.projectId,
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

  return { runId: seeded.runId, runtimeRoot: seeded.runtimeRoot };
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
