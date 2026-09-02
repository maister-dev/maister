import type { NodeAttempt, Run } from "@/lib/db/schema";
import type { ExecutionHosts } from "@/lib/execution-host";

import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadFlowManifest } from "@/lib/config";
import { closeDb } from "@/lib/db/client";
import { runFlow } from "@/lib/flows/runner";
import {
  schema,
  seedGraphRun as seedGraphRunShared,
  type SeededGraphRun,
} from "@/test-support/graph-run-seed";
import { fakeGraphHosts } from "@/test-support/fake-execution-host";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// M26 P1 (ADR-063) round-trip coverage, mapped to the frozen spec's AC matrix
// (.ai-factory/specs/feature-m26-structured-output-run-context.md):
// AC1 sentinel→vars, AC2 file→vars, AC3 forward handoff, AC4 CONFIG failures,
// AC5 no-output.result regression, AC6 per-attempt cli file isolation.

const FIXTURE_PATH = resolve(__dirname, "_fixtures/m26-output-flow");

const OPEN = "```json maister:output";
const CLOSE = "```";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await closeDb();
  await testDatabase?.stop();
});

// Shared seeding plus a flow_revisions row whose installedPath points at
// the local fixture dir so loadRun resolves output.result schema paths
// against it (the 7e981b3c local-fixture pattern).
function seedGraphRun(manifest: unknown): Promise<SeededGraphRun> {
  return seedGraphRunShared(db, manifest, {
    flowRefId: "m26",
    installedPath: FIXTURE_PATH,
    flowRevision: true,
  });
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
  seeded: SeededGraphRun,
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

// ADR-164: the execution seam is a fake host scripted to stream `text` as one
// agent_message_chunk, then a clean end-turn, so an ai_coding/judge node
// finishes with result.stdout === text.
async function makeAgentSupervisor(
  runId: string,
  text: string,
): Promise<ExecutionHosts> {
  return (await fakeGraphHosts(db, runId, { text })).hosts;
}

describe("runGraph — M26 structured node output (P1)", () => {
  it("AC1+AC3: ai_coding sentinel block lands in node_attempts.vars and a downstream cli node renders {{ steps.plan.vars.verdict }} (fixture flow.yaml)", async () => {
    const manifest = await loadFlowManifest(join(FIXTURE_PATH, "flow.yaml"));
    const seeded = await seedGraphRun(manifest);
    const api = await makeAgentSupervisor(
      seeded.runId,
      `Plan ready.\n${OPEN}\n{"verdict":"pass","score":1}\n${CLOSE}\n`,
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: api,
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
    const api = await makeAgentSupervisor(
      seeded.runId,
      `Reviewed.\n${OPEN}\n{"verdict":"fail","score":0}\n${CLOSE}\n`,
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: api,
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
    const api = await makeAgentSupervisor(
      seeded.runId,
      "All done, but no sentinel block here.\n",
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: api,
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
    const api = await makeAgentSupervisor(
      seeded.runId,
      `${OPEN}\n{"verdict":123}\n${CLOSE}\n`,
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: api,
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
              'if [ ! -f once.marker ]; then echo \'{"verdict":"v1"}\' > "$MAISTER_OUTPUT_FILE"; touch once.marker; fi; echo worked; : "{{ review_comments }}"',
          },
          output: { result: { schema: "./schemas/result.json" } },
          transitions: { success: "review" },
        },
        {
          id: "review",
          type: "human",
          finish: {
            human: {
              decisions: ["approve", "rework"],
              commentsVar: "review_comments",
            },
          },
          transitions: { approve: "done", rework: "work" },
          rework: {
            allowedTargets: ["work"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            commentsVar: "review_comments",
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

// --- ADR-162 (Wave 3): the orchestrator sentinel arm -------------------------

// A child run under `parentRunId`, used to drive runOrchestratorStep's
// park-vs-complete decision from real rows (AC-9).
async function seedChildRun(
  seeded: SeededGraphRun,
  status: string,
): Promise<void> {
  const childTaskId = randomUUID();

  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: childTaskId,
    projectId: seeded.projectId,
    title: "child",
    prompt: "p",
    flowId: seeded.flowId,
  });
  await db.insert(schema.runs).values({
    id: randomUUID(),
    taskId: childTaskId,
    projectId: seeded.projectId,
    flowId: seeded.flowId,
    flowVersion: "v1.0.0",
    status,
    parentRunId: seeded.runId,
    rootRunId: seeded.runId,
  });
}

function orchestratorFlow(
  result: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    schemaVersion: 1,
    name: "g",
    compat: { engine_min: "3.6.0" },
    nodes: [
      {
        id: "coordinate",
        type: "orchestrator",
        action: { prompt: "coordinate {{ task.prompt }}" },
        output: { result },
        transitions: { success: "use", pass: "use", fail: "done" },
        ...extra,
      },
      {
        id: "use",
        type: "cli",
        action: { command: 'echo "orc:{{ steps.coordinate.vars.verdict }}"' },
        transitions: { success: "done" },
      },
    ],
  };
}

describe("runGraph — ADR-162 orchestrator structured output", () => {
  it("AC-7: a completing orchestrator's sentinel payload lands in vars and renders downstream", async () => {
    const seeded = await seedGraphRun(
      orchestratorFlow({ schema: "./schemas/result.json" }),
    );

    await seedChildRun(seeded, "Done"); // terminal → not pending → completes

    const api = await makeAgentSupervisor(
      seeded.runId,
      `children settled.\n${OPEN}\n{"verdict":"pass","score":4}\n${CLOSE}\n`,
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: api,
    });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);
    const coordinate = attempts.find((a) => a.nodeId === "coordinate");
    const use = attempts.find((a) => a.nodeId === "use");

    expect(coordinate?.status).toBe("Succeeded");
    expect(coordinate?.vars).toEqual({ verdict: "pass", score: 4 });
    expect(use?.stdout ?? "").toContain("orc:pass");
  }, 60_000);

  it("AC-8: a completing orchestrator with required output and no block fails CONFIG before gates", async () => {
    const gateMarker = "orc-gate-ran.marker";
    const flow = orchestratorFlow(
      { schema: "./schemas/result.json", required: true },
      {
        pre_finish: {
          gates: [
            {
              id: "g",
              kind: "command_check",
              mode: "blocking",
              command: `touch ${gateMarker}`,
            },
          ],
        },
      },
    );
    const seeded = await seedGraphRun(flow);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await makeAgentSupervisor(seeded.runId, "no block here"),
    });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const coordinate = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "coordinate",
    );

    expect(coordinate?.status).toBe("Failed");
    expect(coordinate?.errorCode).toBe("CONFIG");
    expect(coordinate?.stdout ?? "").toContain("maister:output");
    expect(await getGateResults(seeded.runId)).toHaveLength(0);
    await expect(
      access(join(seeded.worktreePath, gateMarker)),
    ).rejects.toThrow();
  }, 60_000);

  it("AC-9: an orchestrator parking on pending children is NOT validated", async () => {
    const seeded = await seedGraphRun(
      orchestratorFlow({ schema: "./schemas/result.json", required: true }),
    );

    await seedChildRun(seeded, "Running"); // pending → the turn parks

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await makeAgentSupervisor(
        seeded.runId,
        "dispatched, awaiting children",
      ),
    });

    expect((await getRun(seeded.runId)).status).toBe("WaitingOnChildren");

    const coordinate = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "coordinate",
    );

    expect(coordinate?.status).toBe("NeedsInput");
    expect(coordinate?.errorCode ?? null).toBeNull();
    expect(coordinate?.stdout ?? "").not.toContain("[structured output]");
  }, 60_000);

  it("AC-15: decide.from routes on an orchestrator's structured output", async () => {
    const flow = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "3.6.0" },
      nodes: [
        {
          id: "coordinate",
          type: "orchestrator",
          action: { prompt: "coordinate" },
          output: { result: { schema: "./schemas/result.json" } },
          decide: { from: "output.verdict" },
          transitions: { pass: "shipped", fail: "done" },
        },
        {
          id: "shipped",
          type: "cli",
          action: { command: 'echo "routed"' },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(flow);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await makeAgentSupervisor(
        seeded.runId,
        `${OPEN}\n{"verdict":"pass"}\n${CLOSE}`,
      ),
    });

    const attempts = await getAttempts(seeded.runId);

    expect(attempts.find((a) => a.nodeId === "shipped")?.status).toBe(
      "Succeeded",
    );
  }, 60_000);
});

// --- ADR-162 (AC-18): output_contract persisted on the closing UPDATE --------

async function fixtureSchemaSha256(name: string): Promise<string> {
  const bytes = await readFile(join(FIXTURE_PATH, "schemas", name));

  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

describe("runGraph — ADR-162 output_contract identity", () => {
  it("AC-18: stamps the contract on the sentinel and file arms, and leaves it NULL where nothing is declared", async () => {
    const sha256 = await fixtureSchemaSha256("result.json");
    const flow = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "1.3.0" },
      nodes: [
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "plan" },
          output: { result: { schema: "./schemas/result.json" } },
          transitions: { success: "emit" },
        },
        {
          id: "emit",
          type: "cli",
          action: {
            command: 'echo \'{"verdict":"ok"}\' > "$MAISTER_OUTPUT_FILE"',
          },
          output: { result: { schema: "./schemas/result.json" } },
          transitions: { success: "plain" },
        },
        {
          id: "plain",
          type: "cli",
          action: { command: 'echo "no declaration"' },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(flow);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await makeAgentSupervisor(
        seeded.runId,
        `${OPEN}\n{"verdict":"pass"}\n${CLOSE}`,
      ),
    });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);
    const base = {
      schemaRef: "./schemas/result.json",
      schemaVersion: 1,
      sha256,
      engineVersion: "3.7.0",
    };

    expect(attempts.find((a) => a.nodeId === "plan")?.outputContract).toEqual({
      ...base,
      transport: "sentinel",
    });
    expect(attempts.find((a) => a.nodeId === "emit")?.outputContract).toEqual({
      ...base,
      transport: "file",
    });
    expect(
      attempts.find((a) => a.nodeId === "plain")?.outputContract ?? null,
    ).toBeNull();
  }, 60_000);

  it("AC-18: a schema-mismatch seam failure records the contract that rejected the payload", async () => {
    const sha256 = await fixtureSchemaSha256("result.json");
    const flow = {
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
    const seeded = await seedGraphRun(flow);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await makeAgentSupervisor(
        seeded.runId,
        `${OPEN}\n{"verdict":7}\n${CLOSE}`,
      ),
    });

    const plan = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "plan",
    );

    expect(plan?.status).toBe("Failed");
    expect(plan?.outputContract).toEqual({
      schemaRef: "./schemas/result.json",
      schemaVersion: 1,
      sha256,
      transport: "sentinel",
      engineVersion: "3.7.0",
    });
  }, 60_000);
});

// --- ADR-162 (AC-16): open payloads survive into vars unmodified -------------

describe("runGraph — ADR-162 open payload round-trip", () => {
  it("AC-16: undeclared nested structures reach node_attempts.vars deep-equal and re-render", async () => {
    const payload = {
      verdict: "pass",
      tags: ["a", "b"],
      payload: { anything: [1, null, { deep: true }] },
      undeclared: { nested: { leaf: "kept", list: [{ k: 1 }] } },
      nullLeaf: null,
    };
    const flow = {
      schemaVersion: 1,
      name: "g",
      compat: { engine_min: "3.6.0" },
      nodes: [
        {
          id: "emit",
          type: "cli",
          action: {
            command: `cat > "$MAISTER_OUTPUT_FILE" <<'JSON'\n${JSON.stringify(payload)}\nJSON`,
          },
          output: { result: { schema: "./schemas/open.json" } },
          transitions: { success: "use" },
        },
        {
          id: "use",
          type: "cli",
          action: {
            command:
              'echo "leaf:{{ steps.emit.vars.undeclared.nested.leaf }} v:{{ steps.emit.vars.verdict }}"',
          },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(flow);

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);

    // Nothing stripped, nothing rewritten — including the undeclared subtree
    // and the null leaf on a field the schema never mentions.
    expect(attempts.find((a) => a.nodeId === "emit")?.vars).toEqual(payload);
    expect(attempts.find((a) => a.nodeId === "use")?.stdout ?? "").toContain(
      "leaf:kept v:pass",
    );
  }, 60_000);
});
