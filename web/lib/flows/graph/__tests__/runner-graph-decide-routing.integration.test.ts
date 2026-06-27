import type { NodeAttempt, Run } from "@/lib/db/schema";
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  testPlatformRunnerRow,
  testRunnerSnapshot,
} from "@/lib/__tests__/runner-fixtures";
import { closeDb } from "@/lib/db/client";
import { runFlow } from "@/lib/flows/runner";

// M38 (ADR-103) runtime routing — from:output, the allow-list guard, and the
// D3 verdict-gate-routing-input seam. Reuses the M26 fixture schema
// (_fixtures/m26-output-flow/schemas/result.json: { verdict: string, score? }).

const schema = fullSchema as unknown as Record<string, any>;
const FIXTURE_PATH = resolve(__dirname, "_fixtures/m26-output-flow");

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let originalDbUrl: string | undefined;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("maister_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
}, 180_000);

afterAll(async () => {
  if (originalDbUrl === undefined) delete process.env.DB_URL;
  else process.env.DB_URL = originalDbUrl;
  await closeDb();
  await pool?.end();
  await container?.stop();
});

type Seeded = { runId: string; slug: string; runtimeRoot: string };

async function seedGraphRun(manifest: unknown): Promise<Seeded> {
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
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
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
    flowRefId: "m38",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: FIXTURE_PATH,
    manifest,
    schemaVersion: 1,
  });
  await db.insert(schema.flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "m38",
    source: "github.com/x/y",
    versionLabel: "v1.0.0",
    resolvedRevision: randomUUID().replace(/-/g, ""),
    manifestDigest: "test-digest",
    manifest,
    schemaVersion: 1,
    installedPath: FIXTURE_PATH,
    setupStatus: "not_required",
    packageStatus: "Installed",
    execTrust: "trusted",
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
    flowRevisionId,
    flowVersion: "v1.0.0",
    status: "Running",
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

// Streams `text` as one agent_message_chunk then a clean end-turn — the gate's
// ai_judgment agent parses its verdict from this text.
function makeAgentSupervisor(text: string): SupervisorApi {
  async function* stream(): AsyncGenerator<SupervisorEvent> {
    yield {
      type: "session.update",
      sessionId: "sup-1",
      monotonicId: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
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
    sendPrompt: (async () => ({
      stopReason: "end_turn" as const,
    })) as unknown as SupervisorApi["sendPrompt"],
    streamSession: (() =>
      stream()) as unknown as SupervisorApi["streamSession"],
    cancelPermission: (async () => ({
      ok: true,
    })) as unknown as SupervisorApi["cancelPermission"],
    checkpointSession: async () => ({
      alreadyCheckpointed: false,
      sessionId: "s",
      monotonicId: 0,
    }),
    deliverPermission: (async () => ({
      ok: true,
    })) as unknown as SupervisorApi["deliverPermission"],
  };
}

const SCHEMA = "./schemas/result.json";

describe("runGraph — M38 decide routing (from: output)", () => {
  it("routes to the branch named by the output value", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "classify",
          type: "cli",
          action: {
            command: `echo '{"verdict":"bug","score":1}' > "$MAISTER_OUTPUT_FILE"`,
          },
          output: { result: { schema: SCHEMA } },
          decide: { from: "output.verdict" },
          transitions: { bug: "fixit", feature: "designit" },
        },
        {
          id: "fixit",
          type: "cli",
          action: { command: "echo fixing" },
          transitions: { success: "done" },
        },
        {
          id: "designit",
          type: "cli",
          action: { command: "echo designing" },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);

    expect(attempts.find((a) => a.nodeId === "classify")?.status).toBe(
      "Succeeded",
    );
    expect(attempts.find((a) => a.nodeId === "fixit")?.status).toBe(
      "Succeeded",
    );
    expect(attempts.find((a) => a.nodeId === "designit")).toBeUndefined();
  }, 60_000);

  it("refuses an output value with no declared transition (allow-list guard → CONFIG → Failed)", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "classify",
          type: "cli",
          action: {
            command: `echo '{"verdict":"banana","score":1}' > "$MAISTER_OUTPUT_FILE"`,
          },
          output: { result: { schema: SCHEMA } },
          decide: { from: "output.verdict" },
          transitions: { bug: "fixit", feature: "designit" },
        },
        {
          id: "fixit",
          type: "cli",
          action: { command: "echo fixing" },
          transitions: { success: "done" },
        },
        {
          id: "designit",
          type: "cli",
          action: { command: "echo designing" },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const attempts = await getAttempts(seeded.runId);

    expect(attempts.find((a) => a.nodeId === "classify")?.status).toBe(
      "Failed",
    );
    expect(attempts.find((a) => a.nodeId === "fixit")).toBeUndefined();
  }, 60_000);
});

describe("runGraph — M38 decide routing (from: verdict, D3 routing-input)", () => {
  it("a fail-verdict gate does NOT hard-fail the node; decide routes on confidence", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "review",
          type: "check",
          action: { command: "true" },
          pre_finish: {
            gates: [
              {
                id: "q",
                kind: "ai_judgment",
                mode: "blocking",
                prompt: "judge it",
              },
            ],
          },
          decide: {
            from: "verdict",
            cases: [
              { when: "confidence >= 0.8", target: "approve" },
              { default: true, target: "human" },
            ],
          },
          transitions: { approve: "done", human: "escalate" },
        },
        {
          id: "escalate",
          type: "cli",
          action: { command: "echo escalating" },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);
    // A "fail" verdict (which would normally fail a blocking ai_judgment gate)
    // with high confidence — decide must route on the confidence (→ approve),
    // proving the gate is routing-input, not a hard-fail.
    const api = makeAgentSupervisor(
      'Reviewed. {"verdict":"fail","confidence":0.95}',
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    // The run reached Review via the `approve → done` terminal — NOT Failed.
    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);

    expect(attempts.find((a) => a.nodeId === "review")?.status).toBe(
      "Succeeded",
    );
    // The decide chose `approve` (terminal), so `escalate` never ran.
    expect(attempts.find((a) => a.nodeId === "escalate")).toBeUndefined();
  }, 60_000);

  it("routes to the default branch on a low-confidence verdict", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "review",
          type: "check",
          action: { command: "true" },
          pre_finish: {
            gates: [
              {
                id: "q",
                kind: "ai_judgment",
                mode: "blocking",
                prompt: "judge it",
              },
            ],
          },
          decide: {
            from: "verdict",
            cases: [
              { when: "confidence >= 0.8", target: "approve" },
              { default: true, target: "human" },
            ],
          },
          transitions: { approve: "done", human: "escalate" },
        },
        {
          id: "escalate",
          type: "cli",
          action: { command: "echo escalating" },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);
    const api = makeAgentSupervisor(
      'Reviewed. {"verdict":"pass","confidence":0.5}',
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    const attempts = await getAttempts(seeded.runId);

    // confidence 0.5 → no when-match → default → human → escalate ran.
    expect(attempts.find((a) => a.nodeId === "review")?.status).toBe(
      "Succeeded",
    );
    expect(attempts.find((a) => a.nodeId === "escalate")?.status).toBe(
      "Succeeded",
    );
  }, 60_000);

  it("fails closed when the routing-input verdict gate produces NO parseable verdict (no silent default-route)", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "review",
          type: "check",
          action: { command: "true" },
          pre_finish: {
            gates: [
              {
                id: "q",
                kind: "ai_judgment",
                mode: "blocking",
                prompt: "judge it",
              },
            ],
          },
          decide: {
            from: "verdict",
            cases: [
              { when: "confidence >= 0.8", target: "approve" },
              { default: true, target: "human" },
            ],
          },
          transitions: { approve: "done", human: "escalate" },
        },
        {
          id: "escalate",
          type: "cli",
          action: { command: "echo escalating" },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);
    // The agent emits prose with NO JSON verdict object — parseVerdict returns
    // null, so the routing-input gate is `failed` and surfaces NO verdict. A
    // broken producer must NOT fall through to the decide `default` (human →
    // escalate); the node fails closed (PRECONDITION) instead.
    const api = makeAgentSupervisor(
      "Reviewed it thoroughly but forgot to emit any JSON.",
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const attempts = await getAttempts(seeded.runId);

    expect(attempts.find((a) => a.nodeId === "review")?.status).toBe("Failed");
    // The default branch (human → escalate) MUST NOT have run.
    expect(attempts.find((a) => a.nodeId === "escalate")).toBeUndefined();
  }, 60_000);

  it("fails closed when an ADVISORY routing-input verdict gate produces NO verdict (advisory must not defeat the fail-closed)", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.7.0" },
      nodes: [
        {
          id: "review",
          type: "check",
          action: { command: "true" },
          pre_finish: {
            gates: [
              {
                id: "q",
                kind: "ai_judgment",
                // The hole Codex found: a non-blocking routing gate. compile
                // requires exactly one ai_judgment/skill_check gate but does NOT
                // constrain its mode, and isEffectivelyBlockingGate is false for
                // advisory — so the per-gate fail-closed never fired.
                mode: "advisory",
                prompt: "judge it",
              },
            ],
          },
          decide: {
            from: "verdict",
            cases: [
              { when: "confidence >= 0.8", target: "approve" },
              { default: true, target: "human" },
            ],
          },
          transitions: { approve: "done", human: "escalate" },
        },
        {
          id: "escalate",
          type: "cli",
          action: { command: "echo escalating" },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);
    // Agent emits prose with NO JSON verdict object → parseVerdict returns null →
    // the advisory routing gate surfaces NO verdict. The node MUST fail closed
    // (PRECONDITION) rather than silently route the default branch
    // (human → escalate).
    const api = makeAgentSupervisor(
      "Reviewed it thoroughly but forgot to emit any JSON.",
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const attempts = await getAttempts(seeded.runId);

    expect(attempts.find((a) => a.nodeId === "review")?.status).toBe("Failed");
    // The default branch (human → escalate) MUST NOT have run.
    expect(attempts.find((a) => a.nodeId === "escalate")).toBeUndefined();
  }, 60_000);
});
