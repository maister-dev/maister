import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { FlowRunnerInspection } from "./flow-preflight";

import { compileManifest } from "@/lib/flows/graph/compile";
import {
  assertNodeLaunchable,
  capabilityBearingSettings,
} from "@/lib/flows/enforcement";
import { MaisterError } from "@/lib/errors";
import { capabilityAgentSchema } from "@/lib/config.schema";

/** Each compiled named, solo or default session uses its actual resolved runner. */
export function assertFlowStaticEnforcement(
  manifest: FlowYamlV1,
  inspection: FlowRunnerInspection,
): void {
  for (const node of compileManifest(manifest).nodes.values()) {
    if (!["ai_coding", "judge", "orchestrator"].includes(node.nodeType))
      continue;
    const slot = inspection.sessions.find(
      (session) => session.sessionName === node.session,
    );
    const agent = capabilityAgentSchema.safeParse(
      slot?.status === "resolved"
        ? slot.resolution.runnerSnapshot.capabilityAgent
        : null,
    );

    if (!slot || slot.status !== "resolved" || !agent.success)
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        "A capability-bearing node has no resolved session runner",
        {
          details: {
            reason: "flow_runner_unresolved",
            slotKey: `session:${node.session}`,
            label: node.id,
          },
        },
      );
    assertNodeLaunchable(
      {
        id: node.id,
        nodeType: node.nodeType,
        settings: capabilityBearingSettings(node.nodeType, node.settings),
      },
      agent.data,
    );
  }
}
