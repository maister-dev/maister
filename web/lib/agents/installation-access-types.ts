import { z } from "zod";

import {
  INSTALLATION_SCOPE_TOOLS,
  type InstallationScope,
} from "../../../runtime/installation-agent-tools";

export const INSTALLATION_AGENT_SCOPES = [
  "projects:read",
  "tasks:read",
  "runs:read",
  "activity:read",
  "observatory:read",
  "memory:read",
  "memory:propose",
  "knowledge:read",
  "knowledge:propose",
  "agent_memory:read",
  "agent_memory:propose",
] as const satisfies readonly InstallationScope[];

const scope = z.enum(INSTALLATION_AGENT_SCOPES);

export const installationFacadeTools = INSTALLATION_SCOPE_TOOLS;
export const installationAgentGrantSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    reach: z.literal("active_projects"),
    scopes: z
      .array(scope)
      .min(1)
      .max(INSTALLATION_AGENT_SCOPES.length)
      .refine((values) => new Set(values).size === values.length),
    memoryEnabled: z.boolean(),
  })
  .refine(
    (grant) =>
      grant.memoryEnabled ||
      !grant.scopes.some((value) => value.startsWith("agent_memory:")),
  );

export type InstallationAgentScope = z.infer<typeof scope>;
export type InstallationAgentGrant = z.infer<
  typeof installationAgentGrantSchema
>;
