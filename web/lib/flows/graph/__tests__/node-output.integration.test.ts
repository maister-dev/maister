import type { NodeAttempt, Run } from "@/lib/db/schema";
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import { loadFlowManifest } from "@/lib/config";
import { runFlow } from "@/lib/flows/runner";

const schema = fullSchema as unknown as Record<string, any>;

// M26 P1 (ADR-063) round-trip coverage, mapped to the frozen spec's AC matrix
// (.ai-factory/specs/feature-m26-structured-output-run-context.md):
// AC1 sentinel→vars, AC2 file→vars, AC3 forward handoff, AC4 CONFIG failures,
// AC5 no-output.result regression, AC6 per-attempt cli file isolation.

const FIXTURE_PATH = resolve(__dirname, "_fixtures/m26-output-flow");

const OPEN = "```json maister:output";
const CLOSE = "```";

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

  // Set DB_URL for runner-agent to call getDb() when db context is unavailable
  // (executeNodeAction does not thread db into the agent ctx — mirrors
  // calibrate-verdict-exec.integration.test.ts).
  originalDbUrl = process.env.DB_URL;
  process.env.DB_URL = container.getConnectionUri();
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

type Seeded = {
  runId: string;
  slug: string;
  runtimeRoot: string;
  worktreePath: string;
};

// Mirrors runner-graph.integration.test.ts seeding, plus a flow_revisions row
// whose installedPath points at the local fixture dir so loadRun resolves
// output.result schema paths against it (the 7e981b3c local-fixture pattern).
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
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "m26",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: FIXTURE_PATH,
    manifest,
    schemaVersion: 1,
  });
  await db.insert(schema.flowRevisions).values({
    id: flowRevisionId,
    flowRefId: "m26",
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
    flowRevisionId,
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

  return { runId, slug, runtimeRoot, worktreePath };
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

async function getGateResults(runId: string): Promise<unknown[]> {
  return (await db
    .select()
    .from(schema.gateResults)
    .where(eq(schema.gateResults.runId, runId))) as unknown[];
}

async function writeDecision(
  seeded: Seeded,
  nodeId: string,
  decision: string,
): Promise<void> {
  const dir = join(
    seeded.runtimeRoot,
    ".maister",
    seeded.slug,
    "runs",
    seeded.runId,
  );

  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `input-${nodeId}.json`),
    JSON.stringify({ decision }),
    "utf8",
  );
}

// SupervisorApi stub: streams `text` as one agent_message_chunk, then a clean
// end-turn, so an ai_coding/judge node finishes with result.stdout === text.
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
    deliverPermission: (async () => ({
      ok: true,
    })) as unknown as SupervisorApi["deliverPermission"],
  };
}

describe("runGraph — M26 structured node output (P1)", () => {
  it("AC1+AC3: ai_coding sentinel block lands in node_attempts.vars and a downstream cli node renders {{ steps.plan.vars.verdict }} (fixture flow.yaml)", async () => {
    const manifest = await loadFlowManifest(join(FIXTURE_PATH, "flow.yaml"));
    const seeded = await seedGraphRun(manifest);
    const api = makeAgentSupervisor(
      `Plan ready.\n${OPEN}\n{"verdict":"pass","score":1}\n${CLOSE}\n`,
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);
    const plan = attempts.find((a) => a.nodeId === "plan");
    const use = attempts.find((a) => a.nodeId === "use");

    expect(plan?.status).toBe("Succeeded");
    expect(plan?.vars).toEqual({ verdict: "pass", score: 1 });
    expect(use?.status).toBe("Succeeded");
    expect(use?.stdout ?? "").toContain("got:pass");
  }, 60_000);

  it("AC1: judge node sentinel payload is captured into vars", async () => {
    const judgeFlow = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.3.0" },
      nodes: [
        {
          id: "verdict",
          type: "judge",
          action: { prompt: "judge it" },
          output: { result: { schema: "./schemas/result.json" } },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(judgeFlow);
    const api = makeAgentSupervisor(
      `Reviewed.\n${OPEN}\n{"verdict":"fail","score":0}\n${CLOSE}\n`,
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect((await getRun(seeded.runId)).status).toBe("Review");
    const verdict = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "verdict",
    );

    expect(verdict?.status).toBe("Succeeded");
    expect(verdict?.vars).toEqual({ verdict: "fail", score: 0 });
  }, 60_000);

  it("AC2+AC3: cli node MAISTER_OUTPUT_FILE round-trip into vars and downstream render", async () => {
    const cliFlow = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.3.0" },
      nodes: [
        {
          id: "emit",
          type: "cli",
          action: {
            command:
              'echo \'{"verdict":"ok","score":7}\' > "$MAISTER_OUTPUT_FILE"',
          },
          output: { result: { schema: "./schemas/result.json" } },
          transitions: { success: "consume" },
        },
        {
          id: "consume",
          type: "cli",
          action: { command: 'echo "fwd:{{ steps.emit.vars.verdict }}"' },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(cliFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);
    const emit = attempts.find((a) => a.nodeId === "emit");
    const consume = attempts.find((a) => a.nodeId === "consume");

    expect(emit?.status).toBe("Succeeded");
    expect(emit?.vars).toEqual({ verdict: "ok", score: 7 });
    expect(consume?.stdout ?? "").toContain("fwd:ok");
  }, 60_000);

  it("AC4: required-absent fails the attempt CONFIG, the run fails, and gates do NOT run", async () => {
    const gateMarker = "gate-ran.marker";
    const requiredFlow = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.3.0" },
      nodes: [
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "plan" },
          output: {
            result: { schema: "./schemas/result.json", required: true },
          },
          pre_finish: {
            gates: [
              {
                id: "marker-gate",
                kind: "command_check",
                mode: "blocking",
                command: `touch ${gateMarker}`,
              },
            ],
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(requiredFlow);
    const api = makeAgentSupervisor("All done, but no sentinel block here.\n");

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const plan = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "plan",
    );

    expect(plan?.status).toBe("Failed");
    expect(plan?.errorCode).toBe("CONFIG");
    expect(plan?.stdout ?? "").toContain("[structured output]");
    expect(plan?.stdout ?? "").toContain("required but absent");

    // The seam failure aborts the finish BEFORE pre_finish gates.
    expect(await getGateResults(seeded.runId)).toHaveLength(0);
    await expect(
      access(join(seeded.worktreePath, gateMarker)),
    ).rejects.toThrow();
  }, 60_000);

  it("AC4: present-but-invalid payload fails CONFIG regardless of required:false (spec-strict)", async () => {
    const optionalFlow = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.3.0" },
      nodes: [
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "plan" },
          output: { result: { schema: "./schemas/result.json" } },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(optionalFlow);
    // Present block, schema mismatch: verdict must be a string.
    const api = makeAgentSupervisor(`${OPEN}\n{"verdict":123}\n${CLOSE}\n`);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi: api,
    });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const plan = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "plan",
    );

    expect(plan?.status).toBe("Failed");
    expect(plan?.errorCode).toBe("CONFIG");
    expect(plan?.stdout ?? "").toContain("schema mismatch");
  }, 60_000);

  it("AC5: a node without output.result gets no transport provisioning and keeps vars {}", async () => {
    const plainFlow = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.3.0" },
      nodes: [
        {
          id: "plain",
          type: "cli",
          action: { command: 'echo "of:${MAISTER_OUTPUT_FILE:-unset}"' },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(plainFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const plain = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "plain",
    );

    expect(plain?.status).toBe("Succeeded");
    expect(plain?.stdout ?? "").toContain("of:unset");
    expect(plain?.vars).toEqual({});
  }, 60_000);

  it("AC6: rework attempt 2 with an absent per-attempt file does NOT inherit attempt 1's output", async () => {
    // Attempt 1 writes its $MAISTER_OUTPUT_FILE and drops a marker in the
    // worktree; attempt 2 sees the marker and writes nothing — its per-attempt
    // file is absent, so (optional) vars stay {} instead of inheriting v1.
    const reworkFlow = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.3.0" },
      nodes: [
        {
          id: "work",
          type: "cli",
          action: {
            command:
              'if [ ! -f once.marker ]; then echo \'{"verdict":"v1"}\' > "$MAISTER_OUTPUT_FILE"; touch once.marker; fi; echo worked',
          },
          output: { result: { schema: "./schemas/result.json" } },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: { human: { decisions: ["approve", "rework"] } },
          transitions: { approve: "done", rework: "work" },
          rework: {
            allowedTargets: ["work"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
          },
        },
      ],
    };
    const seeded = await seedGraphRun(reworkFlow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    await writeDecision(seeded, "review", "rework");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("NeedsInput");

    await writeDecision(seeded, "review", "approve");
    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });
    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);
    const work1 = attempts.find((a) => a.nodeId === "work" && a.attempt === 1);
    const work2 = attempts.find((a) => a.nodeId === "work" && a.attempt === 2);

    expect(work1?.vars).toEqual({ verdict: "v1" });
    expect(work2?.status).toBe("Succeeded");
    expect(work2?.vars).toEqual({});
  }, 60_000);
});
