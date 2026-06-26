import "server-only";

import type { FlowRunnerProfile, FlowYamlV1 } from "@/lib/config.schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import pino from "pino";

import * as schema from "@/lib/db/schema";
import { enumerateRunnerSlots } from "@/lib/acp-runners/runner-slots";
import { flowRunnerRemaps } from "@/lib/db/schema";

type Db = Pick<NodePgDatabase<typeof schema>, "insert">;

const log = pino({
  name: "flow-runner-reconfiguration",
  level: process.env.LOG_LEVEL ?? "info",
});

// M42 (ADR-114): a flow runner slot that needs a per-project binding before
// launch — a `session:` / `consensus:` slot whose declared runner is a
// `runner_profiles` ref (or inline config) with no direct platform-runner match.
export type MissingFlowRunnerTarget = {
  flowRevisionId: string;
  slotKey: string;
  label: string;
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

// M42: enumerate every runner slot whose declared runner lacks a direct platform
// runner match (so it needs a per-project binding). The richer auto-match by
// intent (agent+model+provider) happens at launch resolution where the platform
// runner catalog is available; here we only short-circuit a bare ref that is
// already a platform runner id.
export function missingAcpRunnerTargets(args: {
  flowRevisionId: string;
  manifest: FlowYamlV1;
  platformRunnerIds: ReadonlySet<string>;
}): MissingFlowRunnerTarget[] {
  const missing: MissingFlowRunnerTarget[] = [];

  for (const slot of enumerateRunnerSlots(args.manifest)) {
    // No declared runner -> resolves via the default precedence chain.
    if (slot.runner === undefined) continue;
    // A bare ref that IS already a platform runner id is a direct match.
    if (
      slot.profileRef !== undefined &&
      args.platformRunnerIds.has(slot.profileRef)
    ) {
      continue;
    }

    const runnerProfile =
      slot.profileRef !== undefined
        ? args.manifest.runner_profiles?.[slot.profileRef]
        : undefined;

    missing.push({
      flowRevisionId: args.flowRevisionId,
      slotKey: slot.slotKey,
      label: slot.label,
      ...(runnerProfile ? { runnerProfile } : {}),
    });
  }

  return missing;
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
        slotKey: target.slotKey,
        mappedRunnerId: null,
        status: "Pending" as const,
      })),
    )
    .onConflictDoNothing({
      target: [
        flowRunnerRemaps.projectId,
        flowRunnerRemaps.flowRevisionId,
        flowRunnerRemaps.slotKey,
      ],
    });

  for (const target of missing) {
    log.warn(
      {
        flowId: input.flowId,
        flowRevisionId: input.flowRevisionId,
        projectId: input.projectId,
        slotKey: target.slotKey,
      },
      "flow runner slot requires per-project binding",
    );
  }

  return missing;
}
