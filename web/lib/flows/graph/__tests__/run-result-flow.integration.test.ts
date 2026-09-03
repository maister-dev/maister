import type { NodeAttempt, Run } from "@/lib/db/schema";
import type { ExecutionHosts, SupervisorEvent } from "@/lib/execution-host";
import type { RunResultContract, RunResultRow } from "@/lib/run-results/types";

import { resolve } from "node:path";

import { asc, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "@/lib/db/client";
import { runFlow } from "@/lib/flows/runner";
import {
  createFakeExecutionHost,
  fakeExecutionHosts,
  fakeGraphHosts,
} from "@/test-support/fake-execution-host";
import {
  schema,
  seedGraphRun as seedGraphRunShared,
  type SeededGraphRun,
} from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-165 AC-13 / AC-14, spec C-1.2 and C-3. Driven through the REAL `runFlow`
// seam: the publish must ride the attempt's own transaction, and the value that
// lands must be the PURE payload, not the merged `vars` bag.

const FIXTURE_PATH = resolve(__dirname, "_fixtures/m26-output-flow");
const OPEN = "```json maister:output";
const CLOSE = "```";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

const CONTRACT: RunResultContract = {
  kind: "flow_export",
  schemaRef: "m26@abcdef123456:result",
  schemaVersion: 1,
  sha256: "e".repeat(64),
  required: true,
  producerNodeIds: ["plan"],
  schema: {
    schemaVersion: 1,
    fields: [
      { name: "verdict", type: "string", required: true },
      { name: "score", type: "number" },
    ],
  },
  flowRevisionId: "rev-fixture",
};

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "run_result_flow_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await closeDb();
  await testDatabase?.stop();
});

function seedGraphRun(
  manifest: unknown,
  contract: RunResultContract | null = CONTRACT,
): Promise<SeededGraphRun> {
  return seedGraphRunShared(db, manifest, {
    flowRefId: "m26",
    installedPath: FIXTURE_PATH,
    flowRevision: true,
    run: { resultContract: contract },
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

async function getResults(runId: string): Promise<RunResultRow[]> {
  return (await db
    .select()
    .from(schema.runResults)
    .where(eq(schema.runResults.runId, runId))
    .orderBy(asc(schema.runResults.revision))) as unknown as RunResultRow[];
}

// ADR-166: the execution seam is a fake host scripted to stream `text` as one
// agent_message_chunk, then a clean end-turn.
async function makeAgentSupervisor(
  runId: string,
  text: string,
): Promise<ExecutionHosts> {
  return (await fakeGraphHosts(db, runId, { text })).hosts;
}

/** A one-node ai_coding graph whose producer is `plan`. */
function producerManifest(nodeType = "ai_coding"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "m26-output",
    compat: { engine_min: "3.7.0" },
    nodes: [
      {
        id: "plan",
        type: nodeType,
        action:
          nodeType === "cli"
            ? {
                command:
                  'printf %s \'{"verdict":"pass"}\' > "$MAISTER_OUTPUT_FILE"',
              }
            : { prompt: "plan {{ task.prompt }}" },
        output: { result: { schema: "./schemas/result.json" } },
        transitions: { success: "done" },
      },
    ],
  };
}

describe("flow-run public result — publish at the seam (AC-13)", () => {
  it("publishes ONE valid row whose value deep-equals the payload, undeclared keys included", async () => {
    const seeded = await seedGraphRun(producerManifest());
    const api = await makeAgentSupervisor(
      seeded.runId,
      `Plan ready.\n${OPEN}\n{"verdict":"pass","score":1,"undeclared":{"deep":[1,2]}}\n${CLOSE}\n`,
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: api,
    });

    const rows = await getResults(seeded.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      revision: 1,
      validity: "valid",
      producerKind: "flow_node",
      producerRef: "plan",
      schemaRef: CONTRACT.schemaRef,
      schemaSha256: CONTRACT.sha256,
    });
    // The PURE payload — `node_attempts.vars` is a merged bag, and an
    // implementation that persisted that instead would carry engine vars into
    // the public result.
    expect(rows[0].value).toEqual({
      verdict: "pass",
      score: 1,
      undeclared: { deep: [1, 2] },
    });
    expect(rows[0].nodeAttemptId).toBeTruthy();
    // Engine-derived: the run's real artifacts at publish time, each carrying
    // its own id/kind/nodeId/validity. Nothing here came from the payload — the
    // agent's block declared no artifacts at all.
    expect(rows[0].artifactManifest.length).toBeGreaterThan(0);
    for (const entry of rows[0].artifactManifest) {
      expect(Object.keys(entry).sort()).toEqual([
        "artifactId",
        "kind",
        "nodeId",
        "validity",
      ]);
      expect(typeof entry.kind).toBe("string");
    }
  }, 60_000);

  it("leaves node_attempts.vars and output_contract exactly as before", async () => {
    const seeded = await seedGraphRun(producerManifest());

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await makeAgentSupervisor(
        seeded.runId,
        `${OPEN}\n{"verdict":"pass","score":2}\n${CLOSE}\n`,
      ),
    });

    const plan = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "plan",
    );

    expect(plan?.status).toBe("Succeeded");
    expect(plan?.vars).toEqual({ verdict: "pass", score: 2 });
    expect(plan?.outputContract).toMatchObject({
      schemaRef: "./schemas/result.json",
      transport: "sentinel",
      engineVersion: "3.7.0",
    });
  }, 60_000);

  it("publishes NOTHING when the run carries no contract (a plain flow run)", async () => {
    const seeded = await seedGraphRun(producerManifest(), null);

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await makeAgentSupervisor(
        seeded.runId,
        `${OPEN}\n{"verdict":"pass"}\n${CLOSE}\n`,
      ),
    });

    expect(await getResults(seeded.runId)).toHaveLength(0);
    expect((await getRun(seeded.runId)).status).toBe("Review");
  }, 60_000);

  it("publishes NOTHING when the succeeding node is not a producer", async () => {
    const seeded = await seedGraphRun(producerManifest(), {
      ...CONTRACT,
      // The contract names a node the graph never runs.
      producerNodeIds: ["some-other-node"],
      required: false,
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await makeAgentSupervisor(
        seeded.runId,
        `${OPEN}\n{"verdict":"pass"}\n${CLOSE}\n`,
      ),
    });

    expect(await getResults(seeded.runId)).toHaveLength(0);
  }, 60_000);

  // Transport-agnostic: the publish hangs off the node being a PRODUCER, not
  // off how its payload arrived.
  it("publishes from a cli producer through the file transport", async () => {
    const seeded = await seedGraphRun(producerManifest("cli"));

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await makeAgentSupervisor(seeded.runId, ""),
    });

    const rows = await getResults(seeded.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toEqual({ verdict: "pass" });
    expect(rows[0].producerRef).toBe("plan");
  }, 60_000);

  it("does not publish when the payload FAILS validation (the attempt fails instead)", async () => {
    const seeded = await seedGraphRun(producerManifest());

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      // `verdict` must be a string.
      executionHosts: await makeAgentSupervisor(
        seeded.runId,
        `${OPEN}\n{"verdict":42}\n${CLOSE}\n`,
      ),
    });

    const plan = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "plan",
    );

    expect(plan?.status).toBe("Failed");
    expect((await getRun(seeded.runId)).status).toBe("Failed");
    // A seam failure publishes no row: the run-level `invalid` row belongs to
    // the TERMINAL gate, which this run never reaches on the success path.
    expect(await getResults(seeded.runId)).toHaveLength(0);
  }, 60_000);
});

describe("flow-run public result — supersession and staleness (AC-14)", () => {
  it("a re-run of the producer supersedes revision 1 with revision 2", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "m26-output",
      compat: { engine_min: "3.7.0" },
      nodes: [
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "plan" },
          output: {
            result: { schema: "./schemas/result.json", on_mismatch: "retry" },
          },
          rework: {
            allowedTargets: ["plan"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            commentsVar: "review_comments",
          },
          transitions: { success: "done", retry: "plan" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest);

    // First a malformed payload (drives the on_mismatch retry), then a valid
    // one — two attempts of the SAME producer, so the second publish supersedes.
    let call = 0;
    const fake = createFakeExecutionHost();
    const { hosts } = await fakeExecutionHosts(db, {
      fake,
      runId: seeded.runId,
    });

    // ADR-166: no shared stream script — each prompt turn pushes ITS OWN chunk
    // + exit into that session's queue, so attempt 2 streams a different text.
    fake.setPromptBehavior(async (ctx) => {
      call += 1;
      const text =
        call === 1
          ? `${OPEN}\n{"verdict":"pass"}\n${CLOSE}\n`
          : `${OPEN}\n{"verdict":"second"}\n${CLOSE}\n`;

      fake.pushEvent(ctx.sessionId, {
        type: "session.update",
        sessionId: ctx.sessionId,
        monotonicId: 1,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      } as SupervisorEvent);
      fake.pushEvent(ctx.sessionId, {
        type: "session.exited",
        sessionId: ctx.sessionId,
        monotonicId: 2,
        exitCode: 0,
      } as SupervisorEvent);

      return { stopReason: "end_turn", meta: null };
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: hosts,
    });

    const rows = await getResults(seeded.runId);

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.at(-1)?.validity).toBe("valid");
    // Whatever the loop count, at most ONE row is valid at a time.
    expect(rows.filter((r) => r.validity === "valid")).toHaveLength(1);
  }, 60_000);

  it("only the EXECUTED branch of two alternative producers publishes", async () => {
    const manifest = {
      schemaVersion: 1,
      name: "m26-output",
      compat: { engine_min: "3.7.0" },
      nodes: [
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "plan" },
          output: { result: { schema: "./schemas/result.json" } },
          transitions: { success: "done" },
        },
        {
          id: "alt",
          type: "ai_coding",
          action: { prompt: "alt" },
          output: { result: { schema: "./schemas/result.json" } },
          transitions: { success: "done" },
        },
      ],
    };
    const seeded = await seedGraphRun(manifest, {
      ...CONTRACT,
      producerNodeIds: ["plan", "alt"],
    });

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: await makeAgentSupervisor(
        seeded.runId,
        `${OPEN}\n{"verdict":"pass"}\n${CLOSE}\n`,
      ),
    });

    const rows = await getResults(seeded.runId);

    expect(rows).toHaveLength(1);
    expect(rows[0].producerRef).toBe("plan");
  }, 60_000);
});
