import "server-only";

import type { ParsedAgentDefinition } from "./definition";

import { MaisterError } from "@/lib/errors";

/** Company standalone execution cannot silently discard repository, memory or coordinator declarations. */
export function assertStandaloneCompanyAgentDefinition(
  definition: ParsedAgentDefinition,
): void {
  if (
    definition.workspace !== "none" ||
    definition.workspaceRef !== null ||
    definition.taskQualification !== null ||
    definition.mode !== "session" ||
    definition.riskTier === "destructive"
  )
    throw new MaisterError(
      "CONFIG",
      "Standalone company sessions require a finite workspace-none role without repository qualification",
      { details: { reason: "company_agent_workspace_unsupported" } },
    );
  if (
    definition.memory !== "none" ||
    (definition.capabilityProfile?.mcps?.length ?? 0) > 0
  )
    throw new MaisterError(
      "CONFIG",
      "Company sessions require native knowledge tools; project memory and project MCP bindings require explicit project admission",
      {
        details: { reason: "company_agent_project_capability_unsupported" },
      },
    );
  if (definition.flow !== null)
    throw new MaisterError(
      "CONFIG",
      "This specialist requires its exact company coordinator Flow admission",
      { details: { reason: "company_coordinator_required" } },
    );
}
