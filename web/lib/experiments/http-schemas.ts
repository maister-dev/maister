import { z } from "zod";

import { experimentRubricSchema } from "@/lib/experiments/rubric";
import { experimentVariantConfigSchema } from "@/lib/experiments/variant-config";

export {
  experimentRubricCriterionSchema,
  experimentRubricSchema,
} from "@/lib/experiments/rubric";

export {
  experimentCapabilityOverlaySchema,
  experimentOverlayDeltaSchema,
  experimentVariantConfigSchema,
} from "@/lib/experiments/variant-config";

export const experimentVariantSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    label: z.string().min(1).max(120),
    config: experimentVariantConfigSchema,
  })
  .strict();

export const createExperimentInputSchema = z
  .object({
    taskId: z.string().min(1),
    title: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    baseBranch: z.string().min(1),
    baseRef: z.string().min(1).optional(),
    variants: z.array(experimentVariantSchema).min(2).max(12),
    rubric: experimentRubricSchema.optional(),
  })
  .strict();

export type CreateExperimentInput = z.infer<typeof createExperimentInputSchema>;

export const launchExperimentInputSchema = z
  .object({
    variants: z.union([
      z.literal("all"),
      z.array(z.string().min(1)).min(1),
    ]),
    replicates: z.number().int().min(1).max(10).optional().default(1),
  })
  .strict();

export type LaunchExperimentInput = z.infer<typeof launchExperimentInputSchema>;

export const concludeExperimentInputSchema = z
  .object({
    outcome: z.enum(["winner", "tie", "inconclusive"]),
    winnerVariantKey: z.string().min(1).optional(),
    comment: z.string().max(10_000).optional(),
    scores: z.record(z.string().min(1), z.record(z.string().min(1), z.number())).optional(),
    skippedOptionalCriteria: z.array(z.string().min(1)).optional(),
    abandonLosers: z.boolean().optional().default(false),
  })
  .strict();

export type ConcludeExperimentInput = z.infer<
  typeof concludeExperimentInputSchema
>;

export const abandonExperimentInputSchema = z
  .object({
    reason: z.string().max(4000).optional(),
    stopLiveRuns: z.boolean().optional().default(true),
  })
  .strict();

export type AbandonExperimentInput = z.infer<typeof abandonExperimentInputSchema>;
