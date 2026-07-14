import { z } from "zod";

export const PLAN_REVIEW_MAX_ASSUMPTIONS = 50;
export const PLAN_REVIEW_MAX_DECISIONS = 25;
export const PLAN_REVIEW_MAX_OPTIONS = 8;

const identifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/)
  .describe("stable plan-review identifier");

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

const optionSchema = z
  .object({
    id: identifierSchema,
    label: boundedText(200),
    consequences: boundedText(1_000),
  })
  .strict();

const assumptionSchema = z
  .object({
    id: identifierSchema,
    statement: boundedText(4_000),
    defaultDecision: z
      .object({ id: identifierSchema, label: boundedText(200) })
      .strict(),
    impact: boundedText(4_000),
    blocking: z.literal(false),
  })
  .strict();

const decisionSchema = z
  .object({
    id: identifierSchema,
    question: boundedText(4_000),
    options: z.array(optionSchema).min(2).max(PLAN_REVIEW_MAX_OPTIONS),
    recommendation: identifierSchema.optional(),
    blocking: z.literal(true),
  })
  .strict()
  .superRefine((decision, context) => {
    const optionIds = decision.options.map((option) => option.id);

    if (new Set(optionIds).size !== optionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "Plan-review decision option ids must be unique",
      });
    }

    if (
      decision.recommendation !== undefined &&
      !optionIds.includes(decision.recommendation)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recommendation"],
        message: "Plan-review recommendation must name a declared option id",
      });
    }
  });

export const planReviewContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    plan: z
      .object({
        title: boundedText(200),
        documentArtifact: z.literal("plan-document"),
      })
      .strict(),
    assumptions: z.array(assumptionSchema).max(PLAN_REVIEW_MAX_ASSUMPTIONS),
    decisions: z.array(decisionSchema).max(PLAN_REVIEW_MAX_DECISIONS),
  })
  .strict()
  .superRefine((contract, context) => {
    const ids = [
      ...contract.assumptions.map((assumption) => assumption.id),
      ...contract.decisions.map((decision) => decision.id),
    ];

    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Plan-review assumption and decision ids must be globally unique",
      });
    }
  });

export type PlanReviewV1 = z.infer<typeof planReviewContractSchema>;

export function parsePlanReviewContract(value: unknown): PlanReviewV1 {
  return planReviewContractSchema.parse(value);
}
