/**
 * T4.1 — graph runner materializes a capability profile for a
 * capability-declaring ai_coding node, writes the SDK "local" settings tier to
 * <worktree>/.claude/settings.local.json, and passes the ACP mcp server defs to
 * supervisor createSession.
 *
 * Pins the OBSERVABLE contract only (the createSession spy args + on-disk
 * settings.local.json), NOT the resolver/materialize internals:
 *  (A) a node declaring mcps/skills/tools/permissionMode, with matching
 *      capability_records registered → createSession receives a NON-EMPTY
 *      mcpServers array carrying the seeded `github` server, AND
 *      <worktree>/.claude/settings.local.json exists on disk with
 *      permissions.allow containing the node's tools.
 *  (B) a settings-less CLAUDE node → still writes a MODEL-ONLY
 *      settings.local.json (ADR-076 model-pin) and NO mcpServers, AND
 *  (C) a settings-less CODEX node → NO settings.local.json (codex pins
 *      supervisor-side via setSessionModel) and NO mcpServers.
 *
 * Harness mirrors runner-graph.enforcement.integration.test.ts exactly.
 */
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { mkdtemp, readFile, stat } from "node:fs/promises";
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
    .withDatabase("materialize_test")
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
  runtimeRoot: string;
  worktreePath: string;
};

async function seedGraphRun(
  manifest: unknown,
  agent: "claude" | "codex" = "claude",
): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, agent));
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
    capabilityAgent: agent,
    runnerSnapshot: testRunnerSnapshot(executorId, agent),
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

  return { runId, projectId, runtimeRoot, worktreePath };
}

// Seed the capability_records the node opts into via its settings. Columns
// match lib/db/schema.ts capabilityRecords; material shapes match what
// lib/capabilities/agent-map.ts reads (command/args/envKeys for mcp).
async function seedCapabilityRecords(projectId: string): Promise<void> {
  await db.insert(schema.capabilityRecords).values([
    {
      id: randomUUID(),
      projectId,
      capabilityRefId: "github",
      kind: "mcp",
      label: "GitHub MCP",
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
        tools: { claude: ["Read", "Edit"] },
        permissionMode: "ask",
        enforcement: { mcps: "instruct", tools: "instruct" },
      },
    },
  ],
};

// ai_coding node with NO capability-bearing settings — current behavior must be
// preserved (no profile materialized, no capability preArgs).
const settingsLessFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
    },
  ],
};

describe("runGraph — capability materialization → createSession (T4.1)", () => {
  it("materializes mcp defs + settings.local.json for a capability-declaring ai_coding node", async () => {
    const seeded = await seedGraphRun(capabilityDeclaringFlow);

    await seedCapabilityRecords(seeded.projectId);

    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    // Sanity: the spawn path was reached (the M11c gate did NOT refuse — every
    // declared class resolves to `instructed`), so createSession is invoked
    // exactly once for the single ai_coding node. The contract is on this call's
    // args; the post-createSession run outcome is irrelevant here (the spy
    // stream drives the node to a terminal state exactly as the enforcement
    // template's PASS path does).
    expect(api.createSpy).toHaveBeenCalledTimes(1);

    const arg = api.createSpy.mock.calls[0][0] as {
      mcpServers?: AgentMcpServer[];
    };

    // Observable contract: the ACP mcp server defs are handed to createSession,
    // carrying the seeded `github` server (names + env-key names only, no value).
    const mcpServers = arg.mcpServers ?? [];

    expect(mcpServers.length).toBeGreaterThan(0);

    const github = mcpServers.find((s) => s.name === "github");

    expect(github).toBeDefined();
    expect(github?.envKeys).toContain("GITHUB_TOKEN");

    // ...and the SDK "local" settings tier was written to the WORKTREE ROOT
    // .claude/settings.local.json with the node's tools allow-list.
    const settingsLocalPath = join(
      seeded.worktreePath,
      ".claude",
      "settings.local.json",
    );

    expect((await stat(settingsLocalPath)).isFile()).toBe(true);

    const settings = JSON.parse(await readFile(settingsLocalPath, "utf8"));

    expect(settings.permissions.allow).toEqual(
      expect.arrayContaining(["Read", "Edit"]),
    );
  }, 60_000);

  it("pins the run model via settings.local.json for a settings-less CLAUDE node (ADR-076)", async () => {
    const seeded = await seedGraphRun(settingsLessFlow, "claude");
    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect(api.createSpy).toHaveBeenCalled();

    const arg = api.createSpy.mock.calls[0][0] as {
      mcpServers?: AgentMcpServer[];
    };

    // Model-only pin → no MCP servers, but settings.local.json IS written.
    expect(arg.mcpServers ?? []).toEqual([]);

    const settingsLocalPath = join(
      seeded.worktreePath,
      ".claude",
      "settings.local.json",
    );

    expect((await stat(settingsLocalPath)).isFile()).toBe(true);

    const settings = JSON.parse(await readFile(settingsLocalPath, "utf8"));

    expect(settings.model).toBe("claude-sonnet-4-6");
    expect(settings.availableModels).toEqual(["claude-sonnet-4-6"]);
    // No tools declared → no allow-list synthesized.
    expect(settings.permissions.allow).toBeUndefined();
  }, 60_000);

  it("does NOT write settings.local.json for a settings-less CODEX node (pins supervisor-side)", async () => {
    const seeded = await seedGraphRun(settingsLessFlow, "codex");
    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect(api.createSpy).toHaveBeenCalled();

    const arg = api.createSpy.mock.calls[0][0] as {
      mcpServers?: AgentMcpServer[];
    };

    expect(arg.mcpServers).toBeUndefined();

    const settingsLocalPath = join(
      seeded.worktreePath,
      ".claude",
      "settings.local.json",
    );

    await expect(stat(settingsLocalPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);
});
