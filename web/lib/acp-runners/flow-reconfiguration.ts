import "server-only";

import type {
  AiCodingSettings,
  FlowRunnerProfile,
  FlowYamlV1,
} from "@/lib/config.schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import pino from "pino";

import * as schema from "@/lib/db/schema";
import { capabilityBearingSettings } from "@/lib/flows/enforcement";
import { compileManifest } from "@/lib/flows/graph/compile";
import { flowRunnerRemaps } from "@/lib/db/schema";

type Db = Pick<NodePgDatabase<typeof schema>, "insert">;

const log = pino({
  name: "flow-runner-reconfiguration",
  level: process.env.LOG_LEVEL ?? "info",
});

export type MissingFlowRunnerTarget = {
  flowRevisionId: string;
  stepId: string;
  sourceRunnerId: string;
  runnerProfile?: FlowRunnerProfile;
};

export type SyncFlowRunnerRequirementsInput = {
  db: Db;
  projectId: string | null;
  flowId: string;
  flowRevisionId: string;
  manifest: FlowYamlV1;
  platformRunnerIds: ReadonlySet<string>;
};

function targetKey(target: { stepId: string; sourceRunnerId: string }): string {
  return `${target.stepId}\u0000${target.sourceRunnerId}`;
}

export function missingAcpRunnerTargets(args: {
  flowRevisionId: string;
  manifest: FlowYamlV1;
  platformRunnerIds: ReadonlySet<string>;
}): MissingFlowRunnerTarget[] {
  const graph = compileManifest(args.manifest);
  const missingByKey = new Map<string, MissingFlowRunnerTarget>();

  for (const node of graph.nodes.values()) {
    if (node.nodeType !== "ai_coding") continue;

    const settings = capabilityBearingSettings(node.nodeType, node.settings) as
      | AiCodingSettings
      | undefined;
    const sourceRunnerId = settings?.runner;

    if (!sourceRunnerId || args.platformRunnerIds.has(sourceRunnerId)) continue;

    const runnerProfile = args.manifest.runner_profiles?.[sourceRunnerId];

    missingByKey.set(targetKey({ stepId: node.id, sourceRunnerId }), {
      flowRevisionId: args.flowRevisionId,
      stepId: node.id,
      sourceRunnerId,
      ...(runnerProfile ? { runnerProfile } : {}),
    });
  }

  return [...missingByKey.values()];
}

export async function syncFlowRunnerReconfigurationRequirements(
  input: SyncFlowRunnerRequirementsInput,
): Promise<MissingFlowRunnerTarget[]> {
  const missing = missingAcpRunnerTargets({
    flowRevisionId: input.flowRevisionId,
    manifest: input.manifest,
    platformRunnerIds: input.platformRunnerIds,
  });

  if (missing.length === 0) return [];

  await input.db
    .insert(flowRunnerRemaps)
    .values(
      missing.map((target) => ({
        id: randomUUID(),
        projectId: input.projectId,
        flowRevisionId: target.flowRevisionId,
        stepId: target.stepId,
        sourceRunnerId: target.sourceRunnerId,
        mappedRunnerId: null,
        status: "Pending" as const,
      })),
    )
    .onConflictDoNothing({
      target: [
        flowRunnerRemaps.projectId,
        flowRunnerRemaps.flowRevisionId,
        flowRunnerRemaps.stepId,
        flowRunnerRemaps.sourceRunnerId,
      ],
    });

  for (const target of missing) {
    log.warn(
      {
        flowId: input.flowId,
        flowRevisionId: input.flowRevisionId,
        projectId: input.projectId,
        stepId: target.stepId,
        missingRunnerId: target.sourceRunnerId,
      },
      "flow runner target requires ACP runner reconfiguration",
    );
  }

  return missing;
}
