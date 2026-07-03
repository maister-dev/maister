import { z } from "zod";

import { MaisterError } from "@/lib/errors-core";
import type {
  ExperimentHumanVerdict,
  ExperimentRubric,
  ExperimentVariant,
} from "@/lib/experiments/types";

export const experimentRubricCriterionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]{0,63}$/),
    label: z.string().min(1).max(120),
    guidance: z.string().min(1).max(4000),
    scale: z
      .object({
        min: z.number(),
        max: z.number(),
      })
      .strict()
      .refine((scale) => scale.max > scale.min, {
        message: "scale.max must be greater than scale.min",
      }),
    weight: z.number().min(0).optional().default(1),
    optional: z.boolean().optional(),
  })
  .strict();

export const experimentRubricSchema = z
  .object({
    criteria: z.array(experimentRubricCriterionSchema).min(1),
  })
  .strict();

export const DEFAULT_EXPERIMENT_RUBRIC: ExperimentRubric = {
  criteria: [
    {
      id: "correctness",
      label: "Correctness",
      guidance: "The implementation behaves correctly for the requested task.",
      scale: { min: 1, max: 5 },
      weight: 1,
    },
    {
      id: "completeness",
      label: "Completeness",
      guidance: "The implementation covers the required scenarios and edges.",
      scale: { min: 1, max: 5 },
      weight: 1,
    },
    {
      id: "consistency",
      label: "Consistency",
      guidance:
        "The changes are consistent with existing product and code conventions.",
      scale: { min: 1, max: 5 },
      weight: 1,
    },
    {
      id: "code_quality",
      label: "Code quality",
      guidance: "The solution is maintainable, simple, typed, and well factored.",
      scale: { min: 1, max: 5 },
      weight: 1,
    },
    {
      id: "cost_efficiency",
      label: "Cost efficiency",
      guidance: "The approach uses time and token budget efficiently.",
      scale: { min: 1, max: 5 },
      weight: 1,
    },
    {
      id: "specs_traceability",
      label: "Specs traceability",
      guidance:
        "The result can be traced back to explicit specs and acceptance criteria.",
      scale: { min: 1, max: 5 },
      weight: 1,
      optional: true,
    },
  ],
};

type ValidateVerdictArgs = {
  variants: ExperimentVariant[];
  rubric: ExperimentRubric;
  verdict: ExperimentHumanVerdict;
};

function assertKnownKeys(
  values: Iterable<string>,
  allowed: Set<string>,
  kind: string,
): void {
  for (const value of values) {
    if (allowed.has(value)) continue;

    throw new MaisterError("CONFIG", `unknown ${kind}: ${value}`);
  }
}

export function validateExperimentHumanVerdict(
  args: ValidateVerdictArgs,
): ExperimentHumanVerdict {
  const variantKeys = new Set(args.variants.map((variant) => variant.key));
  const criteriaById = new Map(
    args.rubric.criteria.map((criterion) => [criterion.id, criterion]),
  );
  const criterionIds = new Set(criteriaById.keys());

  if (args.verdict.outcome === "winner") {
    if (!args.verdict.winnerVariantKey) {
      throw new MaisterError("CONFIG", "winner verdict requires winnerVariantKey");
    }
    if (!variantKeys.has(args.verdict.winnerVariantKey)) {
      throw new MaisterError(
        "CONFIG",
        `winner variant is not part of the experiment: ${args.verdict.winnerVariantKey}`,
      );
    }
  }

  if (
    args.verdict.outcome !== "winner" &&
    args.verdict.winnerVariantKey !== undefined
  ) {
    throw new MaisterError(
      "CONFIG",
      "winnerVariantKey is only valid for winner verdicts",
    );
  }

  const skipped = args.verdict.skippedOptionalCriteria ?? [];

  assertKnownKeys(skipped, criterionIds, "rubric criterion");

  for (const criterionId of skipped) {
    const criterion = criteriaById.get(criterionId);

    if (!criterion?.optional) {
      throw new MaisterError(
        "CONFIG",
        `criterion is not optional and cannot be skipped: ${criterionId}`,
      );
    }
  }

  const scores = args.verdict.scores ?? {};

  assertKnownKeys(Object.keys(scores), criterionIds, "rubric criterion");

  for (const [criterionId, byVariant] of Object.entries(scores)) {
    const criterion = criteriaById.get(criterionId);

    if (!criterion) continue;

    assertKnownKeys(Object.keys(byVariant), variantKeys, "variant score key");

    for (const [variantKey, score] of Object.entries(byVariant)) {
      if (score < criterion.scale.min || score > criterion.scale.max) {
        throw new MaisterError(
          "CONFIG",
          `score outside criterion scale: ${criterionId}/${variantKey}`,
        );
      }
    }
  }

  return {
    outcome: args.verdict.outcome,
    ...(args.verdict.winnerVariantKey
      ? { winnerVariantKey: args.verdict.winnerVariantKey }
      : {}),
    ...(args.verdict.comment ? { comment: args.verdict.comment } : {}),
    ...(args.verdict.scores ? { scores: args.verdict.scores } : {}),
    ...(args.verdict.skippedOptionalCriteria
      ? { skippedOptionalCriteria: args.verdict.skippedOptionalCriteria }
      : {}),
  };
}
