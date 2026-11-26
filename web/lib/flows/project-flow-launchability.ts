import "server-only";

import type { CapabilityRefIdSets } from "@/lib/config";

import {
  missingFlowCapability,
  emptyCapabilityRefs,
} from "./project-capability-refs";

import { evaluateFlowLaunchability } from "@/lib/flows/launchability-gate";
import { classifyStoredFlowManifest } from "@/lib/flows/manifest-parser";
import { projectFlowSetupOwner } from "@/lib/execution-host/selected-endpoint";

export type ProjectFlowLaunchabilityInput = {
  enabledRevisionId: string | null;
  enablementState: string;
  hasReadyRunner: boolean;
  projectId?: string;
  capabilityRefs?: CapabilityRefIdSets;
  revision: {
    engineMax: string | null;
    engineMin: string | null;
    manifest: unknown;
    packageStatus: string;
    schemaVersion: number;
    setupStatus: string;
    execTrust?: string | null;
  } | null;
  trustStatus: string;
};

// The board's "can this flow launch right now": the shared launchability gate
// plus the two host facts the pure gate cannot see — a Ready platform runner
// and an executable stored manifest. The delegation trust resolver applies the
// same three, so a flow the board shows as launchable is exactly one an
// orchestrator may delegate to.
export function isProjectFlowLaunchable({
  enabledRevisionId,
  enablementState,
  hasReadyRunner,
  projectId,
  capabilityRefs = emptyCapabilityRefs,
  revision,
  trustStatus,
}: ProjectFlowLaunchabilityInput): boolean {
  const verdict = evaluateFlowLaunchability(
    { enabledRevisionId, enablementState, trustStatus },
    revision,
    projectId ? projectFlowSetupOwner(projectId) : "manager",
  );

  if (!verdict.ok || revision === null) return false;

  if (!hasReadyRunner) return false;
  const stored = classifyStoredFlowManifest(revision.manifest);

  return (
    stored.compatible &&
    missingFlowCapability(stored.manifest, capabilityRefs) === null
  );
}
