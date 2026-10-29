import { z } from "zod";

/** Delivery intent is independent of session mode, workspace and approvals. */
export const AGENT_KINDS = ["code_delivery", "operational"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const operationalCompletionSchema = z
  .object({
    contract: z.literal("operational_v1"),
  })
  .strict();
export type OperationalCompletion = z.infer<typeof operationalCompletionSchema>;

export const OPERATIONAL_ENGINE_MIN = "3.9.0";
