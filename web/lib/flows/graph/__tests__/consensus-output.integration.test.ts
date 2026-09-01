// ADR-162 (Wave 3): the `engine_vars` transport arm. A consensus node's
// `output.result` validates the ENGINE-produced `result.vars` in place — no
// merge, no mutation — through the real post-action seam, the real graph
// runner, a real Postgres, and real ledger writes.
//
// Only the consensus node's ACTION is scripted (`runConsensusNode`), because
// driving the real draft fan-out / cross-verification / synthesis would test the
// consensus machinery (covered by its own suites) rather than the output seam.
// Everything downstream of the action — transport selection, validation,
// persistence, routing — is the real thing.

import type { NodeAttempt, Run } from "@/lib/db/schema";

import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb } from "@/lib/db/client";
import { recordCurrentArtifact } from "@/lib/flows/graph/artifact-store";
import { runFlow } from "@/lib/flows/runner";
import {
  schema,
  seedGraphRun as seedGraphRunShared,
  type SeededGraphRun,
} from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const runConsensusNode = vi.hoisted(() => vi.fn());

vi.mock("@/lib/flows/graph/consensus/runtime", () => ({ runConsensusNode }));

const FIXTURE_PATH = resolve(__dirname, "_fixtures/m26-output-flow");

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_test_consensus_output",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await closeDb();
  await testDatabase?.stop();
});

beforeEach(() => {
  runConsensusNode.mockReset();
});

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

// Scripts the consensus action as a completing synthesis: it records the two
// artifacts the node declares (so the REAL produced-output enforcement still
// runs) and returns the engine vars the real synthesis path returns.
function scriptCompletion(vars: Record<string, unknown>): void {
  runConsensusNode.mockImplementation(
    async (args: {
      loaded: { run: { id: string } };
      node: { id: string };
      nodeAttemptId: string;
      nodeAttemptNumber: number;
      db: unknown;
    }) => {
      for (const [artifactDefId, kind] of [
        ["consensus_plan", "plan"],
        ["debate_log", "human_note"],
      ] as const) {
        await recordCurrentArtifact(
          {
            id: `run:${args.nodeAttemptId}:${artifactDefId}`,
            runId: args.loaded.run.id,
            nodeAttemptId: args.nodeAttemptId,
            nodeId: args.node.id,
            attempt: args.nodeAttemptNumber,
            artifactDefId,
            kind,
            producer: "runner",
            locator: { kind: "inline", text: `${artifactDefId} body` },
            validity: "current",
            requiredFor: ["review"],
            visibility: "shared",
            retention: "run",
          },
          args.db as Parameters<typeof recordCurrentArtifact>[1],
        );
      }

      return { ok: true, stdout: "", vars, durationMs: 1 };
    },
  );
}

function consensusFlow(
  result: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
  downstreamCommand = 'echo "src:{{ steps.decide.vars.consensus.source }}"',
): unknown {
  return {
    schemaVersion: 1,
    name: "consensus-output",
    compat: { engine_min: "3.6.0" },
    nodes: [
      {
        id: "decide",
        type: "consensus",
        prompt: "Pick a plan for {{ task.prompt }}.",
        participants: [
          { id: "architect", runner: "claude" },
          { id: "qa", runner: "claude" },
        ],
        workspace: { mode: "repo_read" },
        material_axes: ["scope"],
        rounds: { mode: "single_pass", max: 1 },
        on_no_consensus: "escalate",
        synthesizer: { runner: "claude" },
        output: {
          produces: [
            { id: "consensus_plan", kind: "plan", current: true },
            { id: "debate_log", kind: "human_note", current: true },
          ],
          ...(result ? { result } : {}),
        },
        transitions: { success: "use", agreement: "use" },
        ...extra,
      },
      {
        id: "use",
        type: "cli",
        action: { command: downstreamCommand },
        transitions: { success: "done" },
      },
    ],
  };
}

const VALID_VARS = {
  consensus: {
    source: "agreement",
    round: 1,
    consensusPlanArtifactId: "consensus_plan",
    debateLogArtifactId: "debate_log",
  },
};

describe("runGraph — ADR-162 consensus engine_vars transport", () => {
  it("AC-10: validates the engine vars in place and persists them unmutated", async () => {
    scriptCompletion(structuredClone(VALID_VARS));

    const seeded = await seedGraphRun(
      consensusFlow({ schema: "./schemas/consensus.json", required: true }),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const attempts = await getAttempts(seeded.runId);
    const decide = attempts.find((a) => a.nodeId === "decide");

    expect(decide?.status).toBe("Succeeded");
    expect(decide?.vars).toEqual(VALID_VARS);
    expect(attempts.find((a) => a.nodeId === "use")?.stdout ?? "").toContain(
      "src:agreement",
    );
  }, 60_000);

  it("AC-10: engine vars that mismatch the schema fail the attempt CONFIG", async () => {
    scriptCompletion({ consensus: { source: "agreement", round: "one" } });

    const seeded = await seedGraphRun(
      consensusFlow({ schema: "./schemas/consensus.json" }),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Failed");

    const decide = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "decide",
    );

    expect(decide?.status).toBe("Failed");
    expect(decide?.errorCode).toBe("CONFIG");
    expect(decide?.stdout ?? "").toContain("schema mismatch");
  }, 60_000);

  it("AC-10: zero-key engine vars are absent — required fails, optional proceeds", async () => {
    scriptCompletion({});

    const required = await seedGraphRun(
      consensusFlow({ schema: "./schemas/consensus.json", required: true }),
    );

    await runFlow(required.runId, { db, runtimeRoot: required.runtimeRoot });

    expect((await getRun(required.runId)).status).toBe("Failed");
    expect(
      (await getAttempts(required.runId)).find((a) => a.nodeId === "decide")
        ?.errorCode,
    ).toBe("CONFIG");

    scriptCompletion({});

    // The downstream node must not read the (empty) vars — an optional-absent
    // payload leaves `vars` at {} and strict templating would CONFIG on it.
    const optional = await seedGraphRun(
      consensusFlow({ schema: "./schemas/consensus.json" }, {}, 'echo "done"'),
    );

    await runFlow(optional.runId, { db, runtimeRoot: optional.runtimeRoot });

    expect((await getRun(optional.runId)).status).toBe("Review");

    const decide = (await getAttempts(optional.runId)).find(
      (a) => a.nodeId === "decide",
    );

    expect(decide?.status).toBe("Succeeded");
    expect(decide?.vars).toEqual({});
  }, 60_000);

  it("AC-15: decide.from routes on the consensus vars", async () => {
    scriptCompletion(structuredClone(VALID_VARS));

    const seeded = await seedGraphRun(
      consensusFlow(
        { schema: "./schemas/consensus.json", required: true },
        { decide: { from: "output.consensus.source" } },
      ),
    );

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    const attempts = await getAttempts(seeded.runId);

    expect(attempts.find((a) => a.nodeId === "use")?.status).toBe("Succeeded");
  }, 60_000);

  it("a consensus node WITHOUT output.result stays byte-identical (vars persisted, no validation)", async () => {
    scriptCompletion(structuredClone(VALID_VARS));

    const seeded = await seedGraphRun(consensusFlow(undefined));

    await runFlow(seeded.runId, { db, runtimeRoot: seeded.runtimeRoot });

    expect((await getRun(seeded.runId)).status).toBe("Review");

    const decide = (await getAttempts(seeded.runId)).find(
      (a) => a.nodeId === "decide",
    );

    expect(decide?.status).toBe("Succeeded");
    expect(decide?.vars).toEqual(VALID_VARS);
  }, 60_000);
});
