import type { NodeAttempt, Run } from "@/lib/db/schema";
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { mkdtemp } from "node:fs/promises";
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

import * as fullSchema from "@/lib/db/schema";
import { runFlow } from "@/lib/flows/runner";

const schema = fullSchema as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("enforcement_test")
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

type Seeded = { runId: string; slug: string; runtimeRoot: string };

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
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db.insert(schema.executors).values({
    id: executorId,
    projectId,
    executorRefId: "claude-sonnet",
    agent: "claude",
    model: "claude-sonnet-4-6",
  });
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
    executorId,
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

  return { runId, slug, runtimeRoot };
}

async function getRun(runId: string): Promise<Run> {
  const rows = (await db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.id, runId))) as unknown as Run[];

  return rows[0];
}

async function getAttempts(runId: string): Promise<NodeAttempt[]> {
  return (await db
    .select()
    .from(schema.nodeAttempts)
    .where(eq(schema.nodeAttempts.runId, runId))) as unknown as NodeAttempt[];
}

// A SupervisorApi spy. The refusal path MUST never reach any of these — a call
// to createSession would mean an agent process was spawned and a permission
// deferred could leak. The pass path (instruct-only) WOULD spawn; we model a
// clean end-turn so the run finishes without a real agent.
function makeSupervisorSpy(): SupervisorApi & {
  createSpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn(async () => ({
    sessionId: "sup-1",
    pid: 1,
    acpSessionId: "acp-1",
  }));

  // A clean end-turn stream so the PASS path's agent completes successfully
  // (and the PASS snapshot test fails ONLY on the missing snapshot, not on a
  // spawn-path crash). The REFUSAL path must never reach this — createSpy
  // asserts zero spawns.
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

// ai_coding node declaring strict mcps — REFUSED on the M11c all-instructed
// table (verdict refused → CONFIG, no agent can enforce mcps).
const strictRefusalFlow = {
  schemaVersion: 1,
  name: "g",
  compat: { engine_min: "1.1.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
      settings: { enforcement: { mcps: "strict" } },
    },
  ],
};

// ai_coding node declaring only instruct enforcement — passes the gate.
const passFlow = {
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
        tools: { claude: ["Edit"] },
        enforcement: { mcps: "instruct", tools: "instruct" },
      },
    },
  ],
};

describe("runGraph — per-node enforcement gate (3.5 / 3.6 / 2.2)", () => {
  it("refuses a strict-mcps ai_coding node: attempt Failed errorCode=CONFIG, run Failed, NO supervisor spawn", async () => {
    const seeded = await seedGraphRun(strictRefusalFlow);
    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    // Run goes terminal Failed.
    expect((await getRun(seeded.runId)).status).toBe("Failed");

    // The node attempt is recorded Failed with the typed errorCode.
    const attempt = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "implement",
    );

    expect(attempt).toBeDefined();
    expect(attempt!.status).toBe("Failed");
    expect(attempt!.errorCode).toBe("CONFIG");

    // 3.6 deferred-release: NO agent session was ever spawned for the refused
    // node, so no permission deferred can leak.
    expect(api.createSpy).not.toHaveBeenCalled();
  }, 60_000);

  it("writes node_attempts.enforcement_snapshot on the REFUSAL path (2.2)", async () => {
    const seeded = await seedGraphRun(strictRefusalFlow);
    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    const attempt = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "implement",
    );

    expect(attempt?.enforcementSnapshot).not.toBeNull();
    expect(attempt!.enforcementSnapshot).toContainEqual({
      class: "mcps",
      declared: "strict",
      capability: "instructed",
      verdict: "refused",
    });
  }, 60_000);

  it("writes node_attempts.enforcement_snapshot on the PASS path (2.2)", async () => {
    const seeded = await seedGraphRun(passFlow);
    const api = makeSupervisorSpy();

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    const attempt = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "implement",
    );

    expect(attempt?.enforcementSnapshot).not.toBeNull();
    // Every declared class resolves to `instructed` on the all-instructed
    // table, never `refused`.
    const verdicts = (attempt!.enforcementSnapshot ?? []).map((e) => e.verdict);

    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts).not.toContain("refused");
  }, 60_000);
});
