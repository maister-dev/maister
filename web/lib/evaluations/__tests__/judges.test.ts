import { describe, expect, it } from "vitest";

import {
  assignBlindLabels,
  seededShuffle,
} from "@/lib/evaluations/judges/blinding";
import {
  validateJudgeResult,
  type JudgeCriterionSpec,
} from "@/lib/evaluations/judges/result-validation";

const CRITERIA: JudgeCriterionSpec[] = [
  { id: "correctness", scaleMin: 0, scaleMax: 5, required: true },
  { id: "style", scaleMin: 0, scaleMax: 5, required: false },
];

describe("validateJudgeResult", () => {
  it("accepts a well-formed result and yields validated criteria", () => {
    const r = validateJudgeResult(
      {
        correctness: { state: "scored", score: 4, confidence: 0.8 },
        style: { state: "not_applicable" },
      },
      CRITERIA,
    );

    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(
        r.criteria.find((c) => c.criterionId === "correctness")?.score,
      ).toBe(4);
      expect(r.criteria.find((c) => c.criterionId === "style")?.state).toBe(
        "not_applicable",
      );
    }
  });

  it("fails closed on an out-of-range score (never clamps)", () => {
    const r = validateJudgeResult(
      { correctness: { state: "scored", score: 9 } },
      CRITERIA,
    );

    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.violations.join()).toMatch(/outside \[0, 5\]/);
  });

  it("rejects an unknown criterion and a scored-without-score", () => {
    const r = validateJudgeResult(
      {
        correctness: { state: "scored" },
        bogus: { state: "scored", score: 3 },
      },
      CRITERIA,
    );

    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.violations.some((v) => v.includes("unknown criterion"))).toBe(
        true,
      );
      expect(r.violations.some((v) => v.includes("no finite score"))).toBe(
        true,
      );
    }
  });

  it("treats an absent non-required criterion as insufficient_evidence, never zero", () => {
    const r = validateJudgeResult(
      { correctness: { state: "scored", score: 3 } },
      CRITERIA,
    );

    expect(r.valid).toBe(true);
    if (r.valid) {
      const style = r.criteria.find((c) => c.criterionId === "style")!;

      expect(style.state).toBe("insufficient_evidence");
      expect(style.score).toBeNull();
    }
  });

  it("rejects an out-of-[0,1] confidence", () => {
    const r = validateJudgeResult(
      { correctness: { state: "scored", score: 3, confidence: 2 } },
      CRITERIA,
    );

    expect(r.valid).toBe(false);
  });

  it("fails a missing required criterion", () => {
    const r = validateJudgeResult(
      { style: { state: "scored", score: 3 } },
      CRITERIA,
    );

    expect(r.valid).toBe(false);
    if (!r.valid)
      expect(r.violations.some((v) => v.includes("required criterion"))).toBe(
        true,
      );
  });
});

describe("blinding + seeded order", () => {
  it("is deterministic for a seed and a permutation of the input", () => {
    const ids = ["p1", "p2", "p3", "p4"];
    const a = seededShuffle(ids, "seed-123");
    const b = seededShuffle(ids, "seed-123");

    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([...ids].sort());
  });

  it("changes the order for a different seed", () => {
    const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];

    expect(seededShuffle(ids, "seed-A")).not.toEqual(
      seededShuffle(ids, "seed-B"),
    );
  });

  it("assigns stable blind labels with no participant identity leaked", () => {
    const { order, labels } = assignBlindLabels(["p1", "p2", "p3"], "seed-x");

    expect(Object.values(labels).sort()).toEqual([
      "Candidate A",
      "Candidate B",
      "Candidate C",
    ]);
    expect(labels[order[0]]).toBe("Candidate A");
    // Same seed → same assignment.
    expect(assignBlindLabels(["p1", "p2", "p3"], "seed-x").labels).toEqual(
      labels,
    );
  });

  it("preserves input order when randomize is false", () => {
    const { order } = assignBlindLabels(["p1", "p2", "p3"], "seed-x", {
      randomize: false,
    });

    expect(order).toEqual(["p1", "p2", "p3"]);
  });
});
