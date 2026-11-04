import "server-only";
import type { AgentActivitySnapshot } from "@/lib/agents/activity-types";
import type { EffectiveAgentDefinition } from "@/lib/agents/effective";
import type { RunnerSnapshot } from "@/lib/acp-runners/resolve";
import type { AgentWorkspace } from "@/lib/db/schema";
import type { LaunchAgentRunInput } from "@/lib/agents/launch";
import type { ParsedAgentDefinition } from "@/lib/agents/definition";

import { createHash } from "node:crypto";

import { canonicalCommandJson } from "../../../runtime/command-json";

/** Keep role identity byte-compatible across launch and durable assignment snapshots. */
export function agentDefinitionSha256(parsed: ParsedAgentDefinition): string {
  const { taskQualification, ...legacyDefinition } = parsed;
  const definition = taskQualification
    ? { ...legacyDefinition, taskQualification }
    : legacyDefinition;

  return createHash("sha256")
    .update(canonicalCommandJson(definition))
    .digest("hex");
}

export function buildAgentActivitySnapshot(
  agentId: string,
  effective: EffectiveAgentDefinition,
): AgentActivitySnapshot {
  return {
    version: 1,
    agentId,
    displayName: effective.parsed.name,
    definitionSha256: agentDefinitionSha256(effective.parsed),
    packageInstallId: effective.packageInstallId,
    packageName: effective.packageName,
    packageVersion: effective.versionLabel,
    packageRevision: effective.resolvedRevision ?? null,
  };
}

export function withAgentComparisonScopes(
  snapshot: AgentActivitySnapshot,
  input: {
    configuration: Record<string, unknown> | null;
    trigger: LaunchAgentRunInput["trigger"];
    taskId: string | null;
    runner: RunnerSnapshot;
    workspace: AgentWorkspace;
    hostId: string;
  },
): AgentActivitySnapshot {
  const scopeHash = (value: object): string =>
    createHash("sha256").update(canonicalCommandJson(value)).digest("hex");
  const trigger =
    input.taskId === null &&
    (input.trigger.source === "manual" || input.trigger.source === "cron")
      ? { source: "scan", payload: input.trigger.payload ?? null }
      : {
          source: input.trigger.source,
          taskId: input.taskId,
          payload: input.trigger.payload ?? null,
        };

  return {
    ...snapshot,
    comparisonScopes: {
      business: scopeHash({
        version: 1,
        definition: snapshot.definitionSha256,
        contract: "operational_v1",
        configuration: input.configuration,
        trigger,
      }),
      infrastructure: scopeHash({
        version: 1,
        runner: input.runner,
        workspace: input.workspace,
        hostId: input.hostId,
      }),
    },
  };
}
