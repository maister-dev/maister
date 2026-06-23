// M39 (ADR-106) — optional-flow enrichment "agent drives a flow": a flow run
// carrying runs.agent_id injects the driving agent's `.md` persona on EVERY
// ai_coding node (augment-not-replace, persona-then-task). This proves the
// graph-runner wire end-to-end (runs.agent_id → the prompt the runner sends to
// the supervisor). The launch-branch + auto-create-task is covered by the unit
// + service layers; here the run is seeded directly (the node-output pattern)
// so runFlow can be awaited without the background-dispatch race.
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { loadFlowManifest } from "@/lib/config";
import { runFlow } from "@/lib/flows/runner";

const schema = fullSchema as unknown as Record<string, any>;

const FLOW_FIXTURE = resolve(__dirname, "_fixtures/persona-flow");
const PERSONA_MARKER = "DRIVER-PERSONA-MARKER";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;
let packageRoot: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  // runner-agent calls getDb() when db is not threaded into the agent ctx.
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();

  // The driving agent's package: maister-agents/driver.md is the persona.
  packageRoot = await mkdtemp(join(tmpdir(), "persona-pkg-"));
  await mkdir(join(packageRoot, "maister-agents"), { recursive: true });
  await writeFile(
    join(packageRoot, "maister-agents", "driver.md"),
    `---
name: Driver
description: the driving persona
workspace: worktree
mode: session
triggers:
  - manual
risk_tier: read_only
---
${PERSONA_MARKER}
You are the driving persona.
`,
    "utf8",
  );
}, 180_000);

afterAll(async () => {
  if (originalDbUrl === undefined) {
    delete process.env.DB_URL;
  } else {
    process.env.DB_URL = originalDbUrl;
  }
  await pool?.end();
  await container?.stop();
});

type Seeded = { runId: string; runtimeRoot: string };

// Seeds a run_kind='flow' run carrying agent_id (the driving agent) + the
// package chain resolveFlowBoundAgent walks (agents row enabled, install
// trusted+Installed, project attachment).
async function seedAgentDrivenFlowRun(
  manifest: unknown,
  agentId: string | null,
): Promise<Seeded> {
  const projectId = randomUUID();
  const slug = `proj-${projectId.slice(0, 8)}`;
  const executorId = randomUUID();
  const flowId = randomUUID();
  const flowRevisionId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const worktreePath = await mkdtemp(join(tmpdir(), "wt-"));
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rt-"));

  await db.insert(schema.projects).values({
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
    taskKey: `T${randomUUID().slice(0, 7)}`.toUpperCase(),
  });
  await db
    .insert(schema.platformAcpRunners)
    .values(testPlatformRunnerRow(executorId, "claude"));
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "persona-flow",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: FLOW_FIXTURE,
    manifest,
    schemaVersion: 1,
  });
  await db.insert(schema.flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "persona-flow",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: randomUUID().replace(/-/g, ""),
    manifestDigest: "test-digest",
    manifest,
    schemaVersion: 1,
    installedPath: FLOW_FIXTURE,
    setupStatus: "not_required",
    packageStatus: "Installed",
    execTrust: "trusted",
  });
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId,
    number: Math.trunc(Math.random() * 1e9) + 1,
    title: "t",
    prompt: "p",
    flowId,
  });
  // Seed the agent + package chain BEFORE the run — runs.agent_id is a FK to
  // agents.id.
  if (agentId) {
    const packageInstallId = randomUUID();

    await db.insert(schema.packageInstalls).values({
      id: packageInstallId,
      sourceUrl: "github.com/acme/persona-pkg",
      name: "persona-pkg",
      versionLabel: "v1.0.0",
      resolvedRevision: "rev-persona-1",
      manifest: {},
      manifestDigest: "digest",
      installedPath: packageRoot,
      packageStatus: "Installed",
      trustStatus: "trusted",
    });
    await db.insert(schema.projectPackageAttachments).values({
      id: randomUUID(),
      projectId,
      packageInstallId,
      packageName: "persona-pkg",
    });
    await db.insert(schema.agents).values({
      id: agentId,
      packageName: "persona-pkg",
      versionLabel: "v1.0.0",
      origin: "git",
      name: "Driver",
      description: "d",
      workspace: "worktree",
      mode: "session",
      triggers: ["manual"],
      riskTier: "read_only",
      sourcePath: join(packageRoot, "maister-agents", "driver.md"),
    });
  }

  await db.insert(schema.runs).values({
    id: runId,
    taskId,
    projectId,
    flowId,
    flowRevisionId,
    agentId,
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

  return { runId, runtimeRoot };
}

// SupervisorApi stub capturing every prompt sent to a session.
function makeCapturingSupervisor(prompts: string[]): SupervisorApi {
  async function* stream(): AsyncGenerator<SupervisorEvent> {
    yield {
      type: "session.update",
      sessionId: "sup-1",
      monotonicId: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "done" },
      },
    } as SupervisorEvent;
    yield {
      type: "session.exited",
      sessionId: "sup-1",
      monotonicId: 2,
      exitCode: 0,
    } as SupervisorEvent;
  }

  return {
    createSession: (async () => ({
      sessionId: "sup-1",
      pid: 1,
      acpSessionId: "acp-1",
    })) as unknown as SupervisorApi["createSession"],
    deleteSession: (async () =>
      undefined) as unknown as SupervisorApi["deleteSession"],
    sendPrompt: (async (_sessionId: string, input: { prompt: string }) => {
      prompts.push(input.prompt);

      return { stopReason: "end_turn" as const };
    }) as unknown as SupervisorApi["sendPrompt"],
    streamSession: (() =>
      stream()) as unknown as SupervisorApi["streamSession"],
    cancelPermission: (async () => ({
      ok: true,
    })) as unknown as SupervisorApi["cancelPermission"],
    deliverPermission: (async () => ({
      ok: true,
    })) as unknown as SupervisorApi["deliverPermission"],
  };
}

describe("agent drives a flow — persona on every ai_coding node (M39, ADR-106)", () => {
  it("injects the driving agent's persona (persona-then-task) on the ai_coding node prompt", async () => {
    const manifest = await loadFlowManifest(join(FLOW_FIXTURE, "flow.yaml"));
    const seeded = await seedAgentDrivenFlowRun(manifest, "persona-pkg:driver");
    const prompts: string[] = [];

    await runFlow(seeded.runId, {
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeCapturingSupervisor(prompts),
    });

    expect(prompts).toHaveLength(1);
    // Persona leads (system block), the node's own task prompt follows.
    expect(prompts[0].startsWith(PERSONA_MARKER)).toBe(true);
    expect(prompts[0]).toContain("\n\n## Task\n\n");
    expect(prompts[0]).toContain("implement the node task");
  });

  it("a flow run WITHOUT agent_id keeps the node's own prompt (no persona)", async () => {
    const manifest = await loadFlowManifest(join(FLOW_FIXTURE, "flow.yaml"));
    const seeded = await seedAgentDrivenFlowRun(manifest, null);
    const prompts: string[] = [];

    await runFlow(seeded.runId, {
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: makeCapturingSupervisor(prompts),
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(PERSONA_MARKER);
    expect(prompts[0]).not.toContain("## Task");
    expect(prompts[0]).toContain("implement the node task");
  });
});
