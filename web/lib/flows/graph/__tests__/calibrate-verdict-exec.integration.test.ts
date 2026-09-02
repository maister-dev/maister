/**
 * Verdict calibration integration test — RED (M15)
 *
 * Tests that the gate executor applies calibration to ai_judgment / skill_check
 * gates, persisting the outcome and confidence threshold to gate_results.verdict.calibration.
 *
 * Mirrors gates-exec.integration.test.ts harness; drives runFlow with a mock supervisorApi
 * returning controlled verdict stdout, then asserts gate_results status + verdict.calibration
 * fields match the truth table (readiness.md).
 *
 * RED: calibration is not yet wired into the executor, so all these gates
 * currently record status: "passed" with NO verdict.calibration, causing
 * cases (b)/(c) to fail (expected status: "failed", actual: "passed").
 */
import type { GateResult } from "@/lib/db/schema";
import type { ExecutionHosts } from "@/lib/execution-host";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "@/lib/db/client";
import { runFlow } from "@/lib/flows/runner";
import { fakeGraphHosts } from "@/test-support/fake-execution-host";
import { schema, seedGraphRun } from "@/test-support/graph-run-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "calibrate_verdict_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await closeDb();
  await testDatabase?.stop();
});

async function getGates(runId: string): Promise<GateResult[]> {
  return (await db
    .select()
    .from(schema.gateResults)
    .where(eq(schema.gateResults.runId, runId))) as unknown as GateResult[];
}

function oneNodeWithAiJudgmentGate(gateConfig: unknown) {
  return {
    schemaVersion: 1,
    name: "g",
    compat: { engine_min: "1.1.0" },
    nodes: [
      {
        id: "work",
        type: "cli",
        action: { command: "echo work" },
        pre_finish: { gates: [gateConfig] },
        transitions: { success: "done" },
      },
    ],
  };
}

/**
 * ADR-164: a fake execution host whose agent turn streams the controlled
 * verdict JSON as agent output (parseVerdict reads it from the collected
 * agent_message_chunk text), then a clean end-turn.
 */
async function makeSupervisorMockForVerdict(
  runId: string,
  verdictJson: string,
): Promise<ExecutionHosts> {
  return (await fakeGraphHosts(db, runId, { text: verdictJson })).hosts;
}

describe("calibrate-verdict-exec (M15) — verdict calibration at gate execution", () => {
  it("(a) confidence_min: 0.8, agent returns confidence: 0.9 → status=passed, outcome=above_threshold", async () => {
    const gateConfig = {
      id: "judge",
      kind: "ai_judgment",
      mode: "blocking",
      prompt: "judge this",
      calibration: { confidence_min: 0.8 },
    };
    const seeded = await seedGraphRun(
      db,
      oneNodeWithAiJudgmentGate(gateConfig),
    );
    const supervisorApi = await makeSupervisorMockForVerdict(
      seeded.runId,
      '{"verdict": "pass", "confidence": 0.9}',
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: supervisorApi,
    });

    const gates = await getGates(seeded.runId);
    const gate = gates.find((g) => g.gateId === "judge");

    expect(gate?.status).toBe("passed");
    expect(gate?.verdict).toBeDefined();
    expect((gate?.verdict as any)?.calibration).toEqual({
      confidenceMin: 0.8,
      rawVerdict: "pass",
      outcome: "above_threshold",
    });
  }, 60_000);

  it("(b) confidence_min: 0.8, agent returns confidence: 0.5 → status=failed, outcome=below_threshold", async () => {
    const gateConfig = {
      id: "judge",
      kind: "ai_judgment",
      mode: "blocking",
      prompt: "judge this",
      calibration: { confidence_min: 0.8 },
    };
    const seeded = await seedGraphRun(
      db,
      oneNodeWithAiJudgmentGate(gateConfig),
    );
    const supervisorApi = await makeSupervisorMockForVerdict(
      seeded.runId,
      '{"verdict": "pass", "confidence": 0.5}',
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: supervisorApi,
    });

    const gates = await getGates(seeded.runId);
    const gate = gates.find((g) => g.gateId === "judge");

    expect(gate?.status).toBe("failed");
    expect(gate?.verdict).toBeDefined();
    expect((gate?.verdict as any)?.calibration).toEqual({
      confidenceMin: 0.8,
      rawVerdict: "pass",
      outcome: "below_threshold",
    });
  }, 60_000);

  it("(c) confidence_min: 0.8, allow_missing_confidence absent, agent returns pass with no confidence → status=failed, outcome=no_confidence", async () => {
    const gateConfig = {
      id: "judge",
      kind: "ai_judgment",
      mode: "blocking",
      prompt: "judge this",
      calibration: { confidence_min: 0.8 },
    };
    const seeded = await seedGraphRun(
      db,
      oneNodeWithAiJudgmentGate(gateConfig),
    );
    const supervisorApi = await makeSupervisorMockForVerdict(
      seeded.runId,
      '{"verdict": "pass"}',
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: supervisorApi,
    });

    const gates = await getGates(seeded.runId);
    const gate = gates.find((g) => g.gateId === "judge");

    expect(gate?.status).toBe("failed");
    expect(gate?.verdict).toBeDefined();
    expect((gate?.verdict as any)?.calibration).toEqual({
      confidenceMin: 0.8,
      rawVerdict: "pass",
      outcome: "no_confidence",
    });
  }, 60_000);

  it("(d) confidence_min: 0.8, allow_missing_confidence: true, agent returns pass with no confidence → status=passed, outcome=missing_confidence_allowed", async () => {
    const gateConfig = {
      id: "judge",
      kind: "ai_judgment",
      mode: "blocking",
      prompt: "judge this",
      calibration: {
        confidence_min: 0.8,
        allow_missing_confidence: true,
      },
    };
    const seeded = await seedGraphRun(
      db,
      oneNodeWithAiJudgmentGate(gateConfig),
    );
    const supervisorApi = await makeSupervisorMockForVerdict(
      seeded.runId,
      '{"verdict": "pass"}',
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: supervisorApi,
    });

    const gates = await getGates(seeded.runId);
    const gate = gates.find((g) => g.gateId === "judge");

    expect(gate?.status).toBe("passed");
    expect(gate?.verdict).toBeDefined();
    expect((gate?.verdict as any)?.calibration).toEqual({
      confidenceMin: 0.8,
      rawVerdict: "pass",
      outcome: "missing_confidence_allowed",
    });
  }, 60_000);

  it("(e) skill_check variant: confidence_min: 0.8, agent returns confidence: 0.9 → status=passed, outcome=above_threshold", async () => {
    const gateConfig = {
      id: "skill-judge",
      kind: "skill_check",
      mode: "blocking",
      skill: "aif-review",
      calibration: { confidence_min: 0.8 },
    };
    const seeded = await seedGraphRun(
      db,
      oneNodeWithAiJudgmentGate(gateConfig),
    );
    const supervisorApi = await makeSupervisorMockForVerdict(
      seeded.runId,
      '{"verdict": "pass", "confidence": 0.9}',
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: supervisorApi,
    });

    const gates = await getGates(seeded.runId);
    const gate = gates.find((g) => g.gateId === "skill-judge");

    expect(gate?.status).toBe("passed");
    expect(gate?.verdict).toBeDefined();
    expect((gate?.verdict as any)?.calibration).toEqual({
      confidenceMin: 0.8,
      rawVerdict: "pass",
      outcome: "above_threshold",
    });
  }, 60_000);

  it("(f) confidence_min: 0.8, agent returns confidence: 2 (out of 0..1) → status=failed, outcome=invalid_confidence", async () => {
    const gateConfig = {
      id: "judge",
      kind: "ai_judgment",
      mode: "blocking",
      prompt: "judge this",
      calibration: { confidence_min: 0.8 },
    };
    const seeded = await seedGraphRun(
      db,
      oneNodeWithAiJudgmentGate(gateConfig),
    );
    const supervisorApi = await makeSupervisorMockForVerdict(
      seeded.runId,
      '{"verdict": "pass", "confidence": 2}',
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      executionHosts: supervisorApi,
    });

    const gates = await getGates(seeded.runId);
    const gate = gates.find((g) => g.gateId === "judge");

    expect(gate?.status).toBe("failed");
    expect(gate?.verdict).toBeDefined();
    expect((gate?.verdict as any)?.calibration).toEqual({
      confidenceMin: 0.8,
      rawVerdict: "pass",
      outcome: "invalid_confidence",
    });
  }, 60_000);
});
