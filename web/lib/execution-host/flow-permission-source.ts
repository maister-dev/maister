import { z } from "zod";

const nodeSourceSchema = z
  .object({
    version: z.literal(1),
    commandId: z.string().min(1),
    nodeAttemptId: z.string().min(1),
    promptOrdinal: z.number().int().nonnegative(),
    assignmentId: z.string().min(1),
    incarnationId: z.string().min(1),
  })
  .strict();

export const gatePermissionSourceSchema = nodeSourceSchema
  .extend({
    variant: z.enum(["gate_ai", "gate_skill"]),
    gateId: z.string().min(1),
    evaluationId: z.string().min(1),
  })
  .strict();
const resumedSourceSchema = nodeSourceSchema
  .extend({
    variant: z.literal("permission_resume"),
    hitlRequestId: z.string().min(1),
  })
  .strict();

export const flowPermissionSourceSchema = z.union([
  nodeSourceSchema,
  gatePermissionSourceSchema,
  resumedSourceSchema,
]);

export const nodePermissionSourceSchema = z.union([
  nodeSourceSchema,
  resumedSourceSchema,
]);

export const flowPermissionEnvelopeSchema = z.object({
  requestId: z.string().min(1),
  supervisorSessionId: z.string().min(1),
  options: z.array(z.object({ optionId: z.string().min(1) })),
  flowPrompt: flowPermissionSourceSchema,
});
