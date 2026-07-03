import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPERIMENT_RUBRIC,
  experimentRubricSchema,
  validateExperimentHumanVerdict,
} from "@/lib/experiments/rubric";

const variants = [
  { key: "claude", label: "Claude", config: {} },
  { key: "codex", label: "Codex", config: {} },
];

describe("experiment rubric single source", () => {
  it("defines the platform default criteria in request order", () => {
    expect(DEFAULT_EXPERIMENT_RUBRIC.criteria.map((criterion) => criterion.id)).toEqual([
      "correctness",
      "completeness",
      "consistency",
      "code_quality",
      "cost_efficiency",
      "specs_traceability",
    ]);
    expect(
      DEFAULT_EXPERIMENT_RUBRIC.criteria.find(
        (criterion) => criterion.id === "specs_traceability",
      )?.optional,
    ).toBe(true);
  });

  it("rejects empty criteria and negative weights", () => {
    expect(experimentRubricSchema.safeParse({ criteria: [] }).success).toBe(false);
    expect(
      experimentRubricSchema.safeParse({
        criteria: [
          {
            id: "bad",
            label: "Bad",
            guidance: "Bad",
            scale: { min: 1, max: 5 },
            weight: -1,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("validates winner, score bounds, and optional skips", () => {
    const rubric = DEFAULT_EXPERIMENT_RUBRIC;

    expect(
      validateExperimentHumanVerdict({
        variants,
        rubric,
        verdict: {
          outcome: "winner",
          winnerVariantKey: "claude",
          scores: { correctness: { claude: 5, codex: 3 } },
          skippedOptionalCriteria: ["specs_traceability"],
        },
      }),
    ).toMatchObject({ outcome: "winner", winnerVariantKey: "claude" });

    expect(() =>
      validateExperimentHumanVerdict({
        variants,
        rubric,
        verdict: { outcome: "winner", winnerVariantKey: "missing" },
      }),
    ).toThrow(/winner variant/);

    expect(() =>
      validateExperimentHumanVerdict({
        variants,
        rubric,
        verdict: {
          outcome: "tie",
          scores: { correctness: { claude: 99 } },
        },
      }),
    ).toThrow(/score outside/);

    expect(() =>
      validateExperimentHumanVerdict({
        variants,
        rubric,
        verdict: {
          outcome: "tie",
          skippedOptionalCriteria: ["correctness"],
        },
      }),
    ).toThrow(/not optional/);
  });
});
