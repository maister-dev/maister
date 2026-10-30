import type { ReactElement } from "react";

import { ProjectAgentsPanel } from "@/components/agents/project-agents-panel";
import { getProjectMcpHub } from "@/lib/mcp/hub-service";
import { listEnabledRunnerSummaries } from "@/lib/queries/project";

export async function ProjectAgentSettings({
  slug,
  projectId,
  agentId,
}: {
  slug: string;
  projectId: string;
  agentId: string;
}): Promise<ReactElement> {
  const [runners, hub] = await Promise.all([
    listEnabledRunnerSummaries(),
    getProjectMcpHub(projectId),
  ]);

  return (
    <ProjectAgentsPanel
      canManage
      agentId={agentId}
      mcpRequirements={hub.requirements}
      projectId={projectId}
      runners={runners.map((runner) => ({
        id: runner.id,
        label: `${runner.capabilityAgent} · ${runner.model}`,
      }))}
      slug={slug}
    />
  );
}
