import { z } from "zod";

import { storedDeliveryPolicySchema } from "@/lib/runs/delivery-policy";
import { executionPolicySchema } from "@/lib/runs/execution-policy";

const identifier = z.string().min(1).max(256);

export const taskLaunchFieldsSchema = z
  .object({
    taskId: identifier,
    expectedTaskRevision: z.number().int().nonnegative(),
    expectedSettingsToken: identifier,
    flowId: identifier.optional(),
    agentId: identifier.optional(),
    workspace: z.enum(["none", "repo_read", "worktree"]).optional(),
    relaunchOfRunId: identifier.optional(),
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
    brainContext: z.boolean().nullable().optional(),
    packageVersions: z
      .record(identifier, z.enum(["keep", "try_once"]))
      .refine((choices) => Object.keys(choices).length <= 64)
      .meta({ maxProperties: 64 })
      .optional(),
  })
  .strict();

export function validateTaskLaunchTarget(
  target: { flowId?: string; agentId?: string; workspace?: string },
  context: z.RefinementCtx,
): void {
  if (target.agentId && target.flowId)
    context.addIssue({
      code: "custom",
      path: ["agentId"],
      message: "Select one execution target",
    });
  if (target.workspace && !target.agentId)
    context.addIssue({
      code: "custom",
      path: ["workspace"],
      message: "Workspace selection requires an agent target",
    });
}

// Metadata retains the target refinement when exporting OpenAPI/MCP JSON schemas.
// `not: {}` is the portable never schema supported by OpenAPI 3 and Zod import.
const taskLaunchTargetContract = {
  anyOf: [
    {
      type: "object",
      properties: { agentId: { not: {} }, workspace: { not: {} } },
    },
    {
      type: "object",
      properties: { flowId: { not: {} }, agentId: { type: "string" } },
      required: ["agentId"],
    },
  ],
};

export const taskLaunchBodySchema = taskLaunchFieldsSchema
  .superRefine(validateTaskLaunchTarget)
  .meta(taskLaunchTargetContract);

export type TaskLaunchRequest = z.infer<typeof taskLaunchBodySchema>;

export const taskLaunchOptionsSchema = taskLaunchFieldsSchema
  .pick({
    taskId: true,
    flowId: true,
    agentId: true,
    workspace: true,
    relaunchOfRunId: true,
    runnerId: true,
    packageVersions: true,
  })
  .superRefine(validateTaskLaunchTarget)
  .meta(taskLaunchTargetContract);
export type TaskLaunchOptionsRequest = z.infer<typeof taskLaunchOptionsSchema>;

export const taskLaunchCancelBodySchema = z
  .object({
    expectedStateVersion: z.number().int().positive(),
  })
  .strict();
export type TaskLaunchCancelRequest = z.infer<
  typeof taskLaunchCancelBodySchema
>;

export const taskLaunchReplaceBodySchema = taskLaunchFieldsSchema
  .extend({
    expectedStateVersion: z.number().int().positive(),
  })
  .superRefine(validateTaskLaunchTarget)
  .meta(taskLaunchTargetContract);
export type TaskLaunchReplaceRequest = z.infer<
  typeof taskLaunchReplaceBodySchema
>;
