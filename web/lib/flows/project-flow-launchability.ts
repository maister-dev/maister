import "server-only";

import { evaluateFlowLaunchability } from "@/lib/flows/launchability-gate";
import { classifyStoredFlowManifest } from "@/lib/flows/manifest-parser";

export type ProjectFlowLaunchabilityInput = {
  enabledRevisionId: string | null;
  enablementState: string;
  hasReadyRunner: boolean;
  revision: {
    engineMax: string | null;
    engineMin: string | null;
    manifest: unknown;
    packageStatus: string;
    schemaVersion: number;
    setupStatus: string;
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
  revision,
  trustStatus,
}: ProjectFlowLaunchabilityInput): boolean {
  const verdict = evaluateFlowLaunchability(
    { enabledRevisionId, enablementState, trustStatus },
    revision,
  );

  if (!verdict.ok || revision === null) return false;

  return (
    hasReadyRunner && classifyStoredFlowManifest(revision.manifest).compatible
  );
}
