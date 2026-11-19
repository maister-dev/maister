import "server-only";

import type { ParsedAgentDefinition } from "./definition";

import { MaisterError } from "@/lib/errors";

/** Company standalone execution cannot silently discard repository, memory or coordinator declarations. */
function assertProjectlessSessionDefinition(
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
      "Company sessions require a finite workspace-none role without repository qualification",
      { details: { reason: "company_agent_workspace_unsupported" } },
    );
  if ((definition.capabilityProfile?.mcps?.length ?? 0) > 0)
    throw new MaisterError(
      "CONFIG",
      "Company sessions require native knowledge tools; project memory and project MCP bindings require explicit project admission",
      {
        details: { reason: "company_agent_project_capability_unsupported" },
      },
    );
}

export function assertCompanySessionDefinition(
  definition: ParsedAgentDefinition,
): void {
  assertProjectlessSessionDefinition(definition);
  if (definition.memory !== "none")
    throw new MaisterError(
      "CONFIG",
      "Company memory requires an installation-scope grant",
      {
        details: { reason: "company_agent_project_capability_unsupported" },
      },
    );
}

export function assertInstallationAgentDefinition(
  definition: ParsedAgentDefinition,
): void {
  assertProjectlessSessionDefinition(definition);
  if (definition.flow !== null)
    throw new MaisterError(
      "CONFIG",
      "Installation agents require a standalone session",
      {
        details: { reason: "installation_agent_coordinator_unsupported" },
      },
    );
}

/** Standalone admission never substitutes a session for a pinned coordinator graph. */
export function assertStandaloneCompanyAgentDefinition(
  definition: ParsedAgentDefinition,
): void {
  assertCompanySessionDefinition(definition);
  if (definition.flow !== null)
    throw new MaisterError(
      "CONFIG",
      "This specialist requires its exact company coordinator Flow admission",
      { details: { reason: "company_coordinator_required" } },
    );
}
