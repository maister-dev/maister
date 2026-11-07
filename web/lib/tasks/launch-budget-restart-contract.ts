import { z } from "zod";

import { taskLaunchBodySchema } from "./launch-schema";

import { executionPolicySchema } from "@/lib/runs/execution-policy";
import { storedDeliveryPolicySchema } from "@/lib/runs/delivery-policy";

export const budgetRestartPreviewSchema = z
  .object({
    request: taskLaunchBodySchema,
    title: z.string(),
    prompt: z.string(),
    flowName: z.string(),
    runnerLabel: z.string(),
    targetRevision: z.string(),
    settings: z
      .object({
        executionPolicy: executionPolicySchema,
        deliveryPolicy: storedDeliveryPolicySchema,
        autoPromote: z.boolean(),
        brainContext: z.boolean().nullable(),
        targetBranch: z.string(),
        workspace: z.enum(["none", "repo_read", "worktree"]),
      })
      .strict(),
  })
  .strict();

export type BudgetRestartPreview = z.infer<typeof budgetRestartPreviewSchema>;
