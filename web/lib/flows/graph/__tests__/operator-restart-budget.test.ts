import { describe, expect, it } from "vitest";

import {
  effectiveAttempts,
  nonCorrectionAttemptCount,
} from "@/lib/flows/graph/rework-baseline";

// T-B10 (AC-B10) — ADR-161: operator restarts must not burn the flow author's
// `rework.maxLoops` budget. The budget expresses tolerance for AUTOMATED rework
// loops; a human stepping in to correct a wandering agent is intervention, not
// a failed iteration. The bound is moved, not removed — a separate
// MAISTER_MAX_OPERATOR_RESTARTS cap bounds them per run.

type Attempt = { nodeId: string; decision: string | null };

function ledger(...decisions: Array<string | null>): Attempt[] {
  return decisions.map((decision) => ({ nodeId: "implement", decision }));
}

describe("T-B10 ADR-161 — operator restarts are outside the rework epoch", () => {
  // Back-compat is the load-bearing property: a run that never used an operator
  // restart must compute byte-identically to pre-ADR-161.
  it("is byte-identical to the two-argument form when there are no operator restarts", () => {
    for (const [attempt, baseline] of [
      [1, null],
      [3, 0],
      [5, 2],
      [7, null],
    ] as const) {
      expect(effectiveAttempts(attempt, baseline, 0)).toBe(
        effectiveAttempts(attempt, baseline),
      );
    }
  });

  it("counts only this node's operator_interrupt attempts", () => {
    const attempts: Attempt[] = [
      { nodeId: "implement", decision: "operator_interrupt" },
      { nodeId: "implement", decision: "rework" },
      { nodeId: "checks", decision: "operator_interrupt" },
      { nodeId: "implement", decision: null },
      { nodeId: "implement", decision: "operator_interrupt" },
    ];

    expect(nonCorrectionAttemptCount(attempts, "implement")).toBe(2);
    expect(nonCorrectionAttemptCount(attempts, "checks")).toBe(1);
    expect(nonCorrectionAttemptCount(attempts, "never-ran")).toBe(0);
  });

  // N operator restarts must not advance the epoch: with maxLoops=3, attempt 6
  // reached purely by 3 operator restarts is still effective 3 — not exhausted.
  it("N operator restarts do not advance the rework epoch", () => {
    const maxLoops = 3;
    const attempts = ledger(
      null,
      "operator_interrupt",
      "operator_interrupt",
      "operator_interrupt",
    );
    const restarts = nonCorrectionAttemptCount(attempts, "implement");

    expect(restarts).toBe(3);
    // 6 prior attempts, 3 of them operator restarts → effective 3, still within
    // the bound, so the node may run again. Without the exclusion this would be
    // 6 > 3 and the flow would have been killed by the operator's own help.
    expect(effectiveAttempts(6, 0, restarts)).toBe(3);
    expect(effectiveAttempts(6, 0, restarts) > maxLoops).toBe(false);
    expect(effectiveAttempts(6, 0, 0) > maxLoops).toBe(true);
  });

  // A genuine rework still exhausts exactly where it did before. The loop-top
  // count is taken BEFORE the append, so `effective > maxLoops` permits
  // appending visit maxLoops + 1 (the initial visit plus maxLoops reworks) and
  // refuses the one after it.
  it("a genuine rework still exhausts at maxLoops + 1 total visits", () => {
    const maxLoops = 3;

    // count = 3 → appending the 4th visit is still allowed.
    expect(effectiveAttempts(maxLoops, 0, 0) > maxLoops).toBe(false);
    // count = 4 → appending the 5th visit overruns.
    expect(effectiveAttempts(maxLoops + 1, 0, 0) > maxLoops).toBe(true);
  });

  // Mixed: operator restarts are subtracted, genuine reworks are not.
  it("subtracts only the operator restarts in a mixed run", () => {
    const attempts = ledger(null, "rework", "operator_interrupt", "rework");
    const restarts = nonCorrectionAttemptCount(attempts, "implement");

    expect(restarts).toBe(1);
    // 5 visits, 1 operator restart → effective 4, which overruns maxLoops = 3.
    expect(effectiveAttempts(5, 0, restarts)).toBe(4);
    expect(effectiveAttempts(5, 0, restarts) > 3).toBe(true);
  });

  // The ADR-118 baseline and the ADR-161 exclusion compose.
  it("composes with the ADR-118 rework_baseline reset", () => {
    expect(effectiveAttempts(10, 4, 2)).toBe(4);
  });
});

// T-CR8 (AC-08) — ADR-175: a crash recover advances the attempt counter for the
// same non-reason an operator restart does, so it is carved out by the SAME
// term. The two are one set, not two filters — a filter that names one member
// is how the next provenance decision gets missed.
describe("T-CR8 ADR-175 — crash recovers are outside the rework epoch too", () => {
  it("counts crash_recover alongside operator_interrupt, per node", () => {
    const attempts: Attempt[] = [
      { nodeId: "implement", decision: "crash_recover" },
      { nodeId: "implement", decision: "operator_interrupt" },
      { nodeId: "implement", decision: "rework" },
      { nodeId: "implement", decision: "review_rework_claim" },
      { nodeId: "checks", decision: "crash_recover" },
      { nodeId: "implement", decision: null },
    ];

    expect(nonCorrectionAttemptCount(attempts, "implement")).toBe(2);
    expect(nonCorrectionAttemptCount(attempts, "checks")).toBe(1);
    // A review rework claim IS a correction — it must keep counting.
    expect(nonCorrectionAttemptCount(attempts, "never-ran")).toBe(0);
  });

  it("N crash recovers do not advance the rework epoch, and a real rework still exhausts it", () => {
    const maxLoops = 2;
    const crashes = ledger(null, "crash_recover", "crash_recover");

    // Attempt 3 reached purely by two crash recovers is still effective 1.
    expect(
      effectiveAttempts(
        3,
        null,
        nonCorrectionAttemptCount(crashes, "implement"),
      ),
    ).toBe(1);

    // The bound is not removed, only moved off crashes: genuine reworks still
    // exhaust at maxLoops + 1.
    const reworks = ledger(null, "rework", "rework");

    expect(
      effectiveAttempts(
        3,
        null,
        nonCorrectionAttemptCount(reworks, "implement"),
      ),
    ).toBe(3);
    expect(3 > maxLoops).toBe(true);
  });
});
