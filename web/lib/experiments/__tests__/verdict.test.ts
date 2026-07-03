import { describe, expect, it } from "vitest";

import { validateExperimentHumanVerdict } from "@/lib/experiments/verdict";
import type { ExperimentRubric, ExperimentVariant } from "@/lib/experiments/types";

const variants: ExperimentVariant[] = [
  { key: "a", label: "A", config: {} },
  { key: "b", label: "B", config: {} },
];

const rubric: ExperimentRubric = {
  criteria: [
    {
      id: "correctness",
      label: "Correctness",
      guidance: "Correct behavior",
      scale: { min: 1, max: 5 },
      weight: 1,
    },
    {
      id: "specs_traceability",
      label: "Specs",
      guidance: "Trace to specs",
      scale: { min: 1, max: 5 },
      weight: 1,
      optional: true,
    },
  ],
};

describe("validateExperimentHumanVerdict", () => {
  it("accepts scores keyed by rubric criterion and variant ids", () => {
    expect(
      validateExperimentHumanVerdict({
        variants,
        rubric,
        verdict: {
          outcome: "winner",
          winnerVariantKey: "a",
          scores: { correctness: { a: 5, b: 3 } },
        },
      }),
    ).toEqual({
      outcome: "winner",
      winnerVariantKey: "a",
      scores: { correctness: { a: 5, b: 3 } },
    });
  });

  it("rejects a winner outside the immutable variant set", () => {
    expect(() =>
      validateExperimentHumanVerdict({
        variants,
        rubric,
        verdict: { outcome: "winner", winnerVariantKey: "missing" },
      }),
    ).toThrowError(/winner variant is not part of the experiment/);
  });

  it("rejects out-of-scale scores", () => {
    expect(() =>
      validateExperimentHumanVerdict({
        variants,
        rubric,
        verdict: {
          outcome: "tie",
          scores: { correctness: { a: 6 } },
        },
      }),
    ).toThrowError(/score outside criterion scale/);
  });

  it("allows optional criteria to be skipped", () => {
    expect(
      validateExperimentHumanVerdict({
        variants,
        rubric,
        verdict: {
          outcome: "inconclusive",
          skippedOptionalCriteria: ["specs_traceability"],
        },
      }).skippedOptionalCriteria,
    ).toEqual(["specs_traceability"]);
  });
});
