import { z } from "zod";

export const agentPermissionSourceSchema = z
  .object({
    version: z.literal(1),
    commandId: z.string().min(1),
    turnId: z.string().min(1),
    promptOrdinal: z.number().int().nonnegative(),
    assignmentId: z.string().min(1),
    incarnationId: z.string().min(1),
  })
  .strict();

export const agentPermissionEnvelopeSchema = z.object({
  requestId: z.string().min(1),
  supervisorSessionId: z.string().min(1),
  options: z.array(z.object({ optionId: z.string().min(1) })),
  agentPrompt: agentPermissionSourceSchema,
});
