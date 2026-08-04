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
import type { SupervisorApi } from "@/lib/flows/runner-agent";
import type { SupervisorEvent } from "@/lib/supervisor-client";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDb } from "@/lib/db/client";
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
 * Mock supervisorApi that returns agent stdout with a controlled verdict JSON.
 * The mock's streamSession emits session.update events with the verdict text,
 * then session.exited with exit code 0.
 */
function makeSupervisorMockForVerdict(verdictJson: string): SupervisorApi {
  async function* sessionStream(): AsyncGenerator<SupervisorEvent> {
    // Emit the verdict as agent output (parseVerdict looks for this in the output).
    // The runner-agent collects text chunks from session.update events with
    // sessionUpdate === "agent_message_chunk" and content.type === "text".
    yield {
      type: "session.update",
      sessionId: "sup-1",
      monotonicId: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: verdictJson },
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
    createSession: vi.fn(async () => ({
      sessionId: "sup-1",
      pid: 1,
      acpSessionId: "acp-1",
    })),
    deleteSession: vi.fn(async () => undefined),
    sendPrompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
    streamSession: vi.fn(() =>
      sessionStream(),
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
  };
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
    const supervisorApi = makeSupervisorMockForVerdict(
      '{"verdict": "pass", "confidence": 0.9}',
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi,
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
    const supervisorApi = makeSupervisorMockForVerdict(
      '{"verdict": "pass", "confidence": 0.5}',
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi,
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
    const supervisorApi = makeSupervisorMockForVerdict('{"verdict": "pass"}');

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi,
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
    const supervisorApi = makeSupervisorMockForVerdict('{"verdict": "pass"}');

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi,
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
    const supervisorApi = makeSupervisorMockForVerdict(
      '{"verdict": "pass", "confidence": 0.9}',
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi,
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
    const supervisorApi = makeSupervisorMockForVerdict(
      '{"verdict": "pass", "confidence": 2}',
    );

    await runFlow(seeded.runId, {
      db,
      runtimeRoot: seeded.runtimeRoot,
      supervisorApi,
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
