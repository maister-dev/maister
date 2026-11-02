import { z } from "zod";

import { storedDeliveryPolicySchema } from "@/lib/runs/delivery-policy";
import { executionPolicySchema } from "@/lib/runs/execution-policy";

const identifier = z.string().min(1).max(256);

export const taskLaunchBodySchema = z
  .object({
    taskId: identifier,
    expectedTaskRevision: z.number().int().nonnegative(),
    expectedSettingsToken: identifier,
    flowId: identifier.optional(),
    runnerId: identifier.optional(),
    baseBranch: identifier.optional(),
    baseCommit: z
      .string()
      .min(7)
      .max(64)
      .regex(/^[a-fA-F0-9]+$/)
      .optional(),
    targetBranch: identifier.optional(),
    deliveryPolicy: storedDeliveryPolicySchema.optional(),
    executionPolicy: executionPolicySchema.optional(),
    autoPromote: z.boolean().optional(),
  })
  .strict();

export type TaskLaunchRequest = z.infer<typeof taskLaunchBodySchema>;

export const taskLaunchCancelBodySchema = z
  .object({
    expectedStateVersion: z.number().int().positive(),
  })
  .strict();
export type TaskLaunchCancelRequest = z.infer<
  typeof taskLaunchCancelBodySchema
>;

export const taskLaunchReplaceBodySchema = taskLaunchBodySchema.extend({
  expectedStateVersion: z.number().int().positive(),
});
export type TaskLaunchReplaceRequest = z.infer<
  typeof taskLaunchReplaceBodySchema
>;
