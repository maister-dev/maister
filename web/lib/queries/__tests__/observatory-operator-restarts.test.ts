import { describe, expect, it } from "vitest";

import {
  rollupCorrectionMetrics,
  type ObservatoryNodeAttemptInput,
} from "@/lib/queries/observatory-core";

// T-B11 (AC-B11) — ADR-160: an operator restart is human intervention, not a
// correction the agent needed, so it must be excluded from BOTH Observatory
// correction counters.
//
// Excluding it from `reworkCount` alone is not enough: `retryCount` is derived
// from `max(attempt) - 1` per (run, node), which an operator restart also
// advances. A single-sided exclusion would still report a fabricated
// correction rate — which is exactly the defect this test fences.

function attempt(
  over: Partial<ObservatoryNodeAttemptInput> = {},
): ObservatoryNodeAttemptInput {
  return {
    id: `att-${Math.random().toString(36).slice(2)}`,
    runId: "run-1",
    nodeId: "implement",
    nodeType: "ai_coding",
    attempt: 1,
    status: "Succeeded",
    ...over,
  } as ObservatoryNodeAttemptInput;
}

function rollup(nodeAttempts: ObservatoryNodeAttemptInput[]) {
  return rollupCorrectionMetrics({
    runs: [{ id: "run-1", active: false }],
    nodeAttempts,
  } as never);
}

describe("T-B11 ADR-160 — operator restarts are excluded from both counters", () => {
  it("reports correctionRate 0 for a run whose only churn was operator restarts", () => {
    const m = rollup([
      attempt({ attempt: 1, status: "Reworked", decision: "operator_interrupt" }),
      attempt({ attempt: 2, status: "Reworked", decision: "operator_interrupt" }),
      attempt({ attempt: 3, status: "Succeeded" }),
    ]);

    expect(m.reworkCount).toBe(0);
    // max(attempt) - 1 = 2, minus the 2 operator restarts = 0.
    expect(m.retryCount).toBe(0);
    expect(m.correctionRate).toBe(0);
  });

  it("counts only the genuine reworks in a mixed run", () => {
    const m = rollup([
      attempt({ attempt: 1, status: "Reworked", decision: "rework" }),
      attempt({ attempt: 2, status: "Reworked", decision: "operator_interrupt" }),
      attempt({ attempt: 3, status: "Succeeded" }),
    ]);

    expect(m.reworkCount).toBe(1);
    // max(attempt) - 1 = 2, minus the 1 operator restart = 1.
    expect(m.retryCount).toBe(1);
    expect(m.correctionRate).toBe(2);
  });

  // Back-compat: a run that never used an operator restart is unchanged.
  it("leaves a run with no operator restarts byte-identical", () => {
    const m = rollup([
      attempt({ attempt: 1, status: "Reworked", decision: "rework" }),
      attempt({ attempt: 2, status: "Succeeded" }),
    ]);

    expect(m.reworkCount).toBe(1);
    expect(m.retryCount).toBe(1);
    expect(m.correctionRate).toBe(2);
  });

  // The single-sided-exclusion trap, pinned explicitly: if only `reworkCount`
  // had been filtered, retryCount would still read 2 here.
  it("does not leave retryCount inflated when reworkCount is filtered", () => {
    const m = rollup([
      attempt({ attempt: 1, status: "Reworked", decision: "operator_interrupt" }),
      attempt({ attempt: 2, status: "Reworked", decision: "operator_interrupt" }),
      attempt({ attempt: 3, status: "Running" }),
    ]);

    expect(m.reworkCount).toBe(0);
    expect(m.retryCount).not.toBe(2);
    expect(m.retryCount).toBe(0);
  });
});
