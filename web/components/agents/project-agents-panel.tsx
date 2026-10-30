import type { ReactElement } from "react";
import type { AgentActivitySummary } from "@/lib/agents/activity-queries";
import type { AgentConfigParam } from "@/lib/agents/definition";

import {
  AgentsAttachPanel,
  type AgentRecommendedView,
} from "@/components/board/panels/agents-attach-panel";
import { getProjectAgentsView } from "@/lib/agents/project-links";
import { AGENT_TRIGGER_EVENT_KINDS } from "@/lib/domain-events/taxonomy";

function toRecommendedView(rec: unknown): AgentRecommendedView | null {
  if (!rec || typeof rec !== "object") return null;
  const r = rec as {
    runner?: string;
    branch_base?: string;
    cron?: { expr: string; timezone: string };
    events?: string[];
    mention?: boolean;
    executionPolicy?: {
      autoApply?: "off" | "permissions" | "full";
      onBudgetBreach?: "escalate" | "terminate" | "terminate_restorable";
    };
  };

  return {
    ...(r.runner !== undefined ? { runner: r.runner } : {}),
    ...(r.branch_base !== undefined ? { branchBase: r.branch_base } : {}),
    ...(r.cron !== undefined ? { cron: r.cron } : {}),
    ...(r.events !== undefined ? { events: r.events } : {}),
    ...(r.mention !== undefined ? { mention: r.mention } : {}),
    ...(r.executionPolicy !== undefined
      ? { executionPolicy: r.executionPolicy }
      : {}),
  };
}

export async function ProjectAgentsPanel({
  slug,
  projectId,
  canManage,
  runners,
  mcpRequirements,
  agentId,
}: {
  slug: string;
  projectId: string;
  canManage: boolean;
  agentId?: string;
  runners: Array<{ id: string; label: string }>;
  mcpRequirements: Array<{
    refId: string;
    declaredBy: string[];
    classification: string;
  }>;
}): Promise<ReactElement> {
  const view = await getProjectAgentsView(projectId);
  // ADR-129 (W-G, T7.2): an agent's effective MCPs = the refs it declares,
  // resolved through the project's bindings. The hub already threads bindings
  // into `requirements` and stamps `declaredBy: ["agent:<id>", …]`, so filtering
  // by that label yields each agent's effective set (D5 — one resolution path).
  const effectiveMcpsFor = (
    agentId: string,
  ): Array<{ refId: string; classification: string }> =>
    mcpRequirements
      .filter((r) => r.declaredBy.includes(`agent:${agentId}`))
      .map((r) => ({ refId: r.refId, classification: r.classification }));

  return (
    <AgentsAttachPanel
      attached={view.attached
        .filter((row) => agentId === undefined || row.agent.id === agentId)
        .map((row) => ({
          linkId: row.linkId,
          activity: row.agent.activity as AgentActivitySummary | undefined,
          enabled: row.enabled,
          runnerOverrideId: row.runnerOverrideId,
          branchBase: row.branchBase,
          executionPolicyOverride: row.executionPolicyOverride,
          config: row.config,
          canReadBrain: row.canReadBrain,
          canWriteBrain: row.canWriteBrain,
          memoryEnabled: row.memoryEnabled,
          crossProjectReach: row.crossProjectReach,
          schedulesRevision: row.schedulesRevision,
          schedules: row.schedules,
          agent: {
            id: row.agent.id as string,
            name: row.agent.name as string,
            packageName: row.agent.packageName as string,
            kind: row.agent.kind as "operational" | "code_delivery",
            workspace: row.agent.workspace as string,
            mode: row.agent.mode as string,
            triggers: row.agent.triggers as string[],
            riskTier: row.agent.riskTier as string,
            enabled: row.agent.enabled as boolean,
            quarantinedAt: row.agent.quarantinedAt
              ? new Date(row.agent.quarantinedAt as Date).toISOString()
              : null,
            flowRef: (row.agent.flowRef as string | null) ?? null,
            recommended: toRecommendedView(row.agent.recommended),
            configSchema:
              (row.agent.configSchema as AgentConfigParam[] | null) ?? null,
            effectiveMcps: effectiveMcpsFor(row.agent.id as string),
          },
        }))}
      available={(agentId === undefined ? view.available : []).map((agent) => ({
        id: agent.id as string,
        name: agent.name as string,
        packageName: agent.packageName as string,
        recommended: toRecommendedView(agent.recommended),
        configSchema: (agent.configSchema as AgentConfigParam[] | null) ?? null,
      }))}
      canManage={canManage}
      eventKinds={[...AGENT_TRIGGER_EVENT_KINDS]}
      runners={runners}
      slug={slug}
    />
  );
}
