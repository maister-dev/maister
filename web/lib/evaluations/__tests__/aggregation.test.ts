import { describe, expect, it } from "vitest";

import {
  computeAggregate,
  type AggCriterion,
  type AttemptResult,
} from "@/lib/evaluations/aggregation/algorithms";
import { classifyDisagreement } from "@/lib/evaluations/aggregation/disagreement";

const CRITERIA: AggCriterion[] = [
  {
    id: "correctness",
    weight: 3,
    normalizedWeight: 0.75,
    scaleMin: 0,
    scaleMax: 5,
    optional: false,
  },
  {
    id: "style",
    weight: 1,
    normalizedWeight: 0.25,
    scaleMin: 0,
    scaleMax: 5,
    optional: true,
  },
];

function attempt(
  id: string,
  correctness: number | null,
  style: number | null,
  valid = true,
): AttemptResult {
  return {
    attemptId: id,
    valid,
    criteria: {
      correctness: {
        state: correctness === null ? "insufficient_evidence" : "scored",
        score: correctness,
      },
      style: {
        state: style === null ? "insufficient_evidence" : "scored",
        score: style,
      },
    },
  };
}

describe("weighted_mean@1", () => {
  it("weights criteria and rounds only for display", () => {
    const r = computeAggregate({
      algorithm: "weighted_mean@1",
      quorum: 2,
      criteria: CRITERIA,
      attempts: [attempt("a", 4, 2), attempt("b", 5, 3)],
    });

    // correctness mean = 4.5, style mean = 2.5; total = (3*4.5 + 1*2.5)/4 = 4.0
    expect(r.perCriterion[0].rawValue).toBe(4.5);
    expect(r.rawTotal).toBe(4);
    expect(r.quorumMet).toBe(true);
    expect(r.includedAttemptIds).toEqual(["a", "b"]);
  });

  it("excludes invalid attempts and records the reason", () => {
    const r = computeAggregate({
      algorithm: "weighted_mean@1",
      quorum: 2,
      criteria: CRITERIA,
      attempts: [attempt("a", 4, 2), attempt("b", 5, 3, false)],
    });

    expect(r.quorumMet).toBe(false);
    expect(r.excludedAttempts).toEqual([{ attemptId: "b", reason: "invalid" }]);
  });

  it("treats a missing criterion as insufficient_evidence, never zero, and renormalizes the total", () => {
    const r = computeAggregate({
      algorithm: "weighted_mean@1",
      quorum: 1,
      criteria: CRITERIA,
      attempts: [attempt("a", 4, null)],
    });

    const style = r.perCriterion.find((c) => c.criterionId === "style")!;

    expect(style.state).toBe("insufficient_evidence");
    expect(style.rawValue).toBeNull();
    // total renormalizes over correctness only → 4 (never dragged to 0 by style)
    expect(r.rawTotal).toBe(4);
  });

  it("is null total (not zero) when no criterion was scored", () => {
    const r = computeAggregate({
      algorithm: "weighted_mean@1",
      quorum: 1,
      criteria: CRITERIA,
      attempts: [attempt("a", null, null)],
    });

    expect(r.rawTotal).toBeNull();
    expect(r.displayTotal).toBeNull();
  });

  it("enforces item and total caps", () => {
    const capped: AggCriterion[] = [
      { ...CRITERIA[0], itemCap: 4 },
      CRITERIA[1],
    ];
    const r = computeAggregate({
      algorithm: "weighted_mean@1",
      quorum: 1,
      criteria: capped,
      attempts: [attempt("a", 5, 5)],
      totalMax: 4.2,
    });

    expect(r.perCriterion[0].rawValue).toBe(4);
    expect(r.perCriterion[0].capped).toBe(true);
    expect(r.totalCapped).toBe(true);
    expect(r.rawTotal).toBe(4.2);
  });
});

describe("median@1 and majority@1", () => {
  it("median picks the middle scored value per criterion", () => {
    const r = computeAggregate({
      algorithm: "median@1",
      quorum: 3,
      criteria: [CRITERIA[0]],
      attempts: [
        attempt("a", 2, null),
        attempt("b", 4, null),
        attempt("c", 5, null),
      ],
    });

    expect(r.perCriterion[0].rawValue).toBe(4);
  });

  it("majority picks the most frequent value, ties to the lowest", () => {
    const r = computeAggregate({
      algorithm: "majority@1",
      quorum: 1,
      criteria: [CRITERIA[0]],
      attempts: [attempt("a", 3, null), attempt("b", 5, null)],
    });

    // 3 and 5 each appear once → tie resolves to the lower value 3
    expect(r.perCriterion[0].rawValue).toBe(3);
  });
});

describe("disagreement classification", () => {
  it("flags high disagreement on a wide score spread and requires review", () => {
    const agg = computeAggregate({
      algorithm: "weighted_mean@1",
      quorum: 2,
      criteria: [CRITERIA[0]],
      attempts: [attempt("a", 1, null), attempt("b", 5, null)],
    });
    const d = classifyDisagreement({
      perCriterion: agg.perCriterion,
      attemptConfidences: [],
      validAttemptCount: 2,
      expectedAttemptCount: 2,
      objectiveGatingFailed: false,
      topCriterionValue: agg.perCriterion[0].displayValue,
      criterionScaleMax: 5,
    });

    expect(d.level).toBe("high");
    expect(d.reviewRequired).toBe(true);
    expect(d.signals.maxScoreSpread).toBe(4);
  });

  it("does not relabel incomplete panel coverage as agreement/confidence", () => {
    const agg = computeAggregate({
      algorithm: "weighted_mean@1",
      quorum: 1,
      criteria: [CRITERIA[0]],
      attempts: [attempt("a", 4, null)],
    });
    const d = classifyDisagreement({
      perCriterion: agg.perCriterion,
      attemptConfidences: [],
      validAttemptCount: 1,
      expectedAttemptCount: 3,
      objectiveGatingFailed: false,
      topCriterionValue: 4,
      criterionScaleMax: 5,
    });

    expect(d.signals.panelIncomplete).toBe(true);
    expect(d.level).toBe("none");
  });

  it("flags an objective contradiction (high score while a gate failed)", () => {
    const d = classifyDisagreement({
      perCriterion: [
        {
          criterionId: "correctness",
          state: "scored",
          rawValue: 5,
          displayValue: 5,
          includedAttemptIds: ["a", "b"],
          spread: 0,
          capped: false,
        },
      ],
      attemptConfidences: [],
      validAttemptCount: 2,
      expectedAttemptCount: 2,
      objectiveGatingFailed: true,
      topCriterionValue: 5,
      criterionScaleMax: 5,
    });

    expect(d.signals.objectiveContradiction).toBe(true);
    expect(d.reviewRequired).toBe(true);
  });
});
