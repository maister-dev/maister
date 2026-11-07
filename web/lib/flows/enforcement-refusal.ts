import { z } from "zod";

import { flowNodeIdSchema } from "@/lib/config.schema";

/** Public enforcement identities only; settings, causes and source text never enter this contract. */
export const nodeEnforcementRefusalSchema = z
  .object({
    reason: z.literal("flow_settings_enforcement_refused"),
    nodeId: flowNodeIdSchema,
    capabilityClass: z.enum([
      "mcps",
      "tools",
      "skills",
      "restrictions",
      "permissionMode",
      "workspaceAccess",
      "hooks",
    ]),
    capabilityAgent: z.enum(["claude", "codex", "gemini", "opencode", "mimo"]),
    declared: z.literal("strict"),
    capability: z.enum(["instructed", "unsupported"]),
  })
  .strict();

export type NodeEnforcementRefusal = z.infer<
  typeof nodeEnforcementRefusalSchema
>;
