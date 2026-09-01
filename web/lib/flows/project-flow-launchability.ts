import "server-only";

import { LAUNCHABLE_FLOW_ENABLEMENT_STATES } from "@/lib/flows/enablement-states";
import {
  isEngineCompatible,
  isSchemaVersionSupported,
} from "@/lib/flows/engine-version";
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

export function isProjectFlowLaunchable({
  enabledRevisionId,
  enablementState,
  hasReadyRunner,
  revision,
  trustStatus,
}: ProjectFlowLaunchabilityInput): boolean {
  if (
    !enabledRevisionId ||
    !LAUNCHABLE_FLOW_ENABLEMENT_STATES.has(enablementState) ||
    trustStatus === "untrusted" ||
    !revision ||
    revision.packageStatus !== "Installed" ||
    revision.setupStatus === "pending" ||
    revision.setupStatus === "failed" ||
    !isSchemaVersionSupported(revision.schemaVersion) ||
    !isEngineCompatible(
      revision.engineMin ?? undefined,
      revision.engineMax ?? undefined,
    ).compatible
  ) {
    return false;
  }

  return (
    hasReadyRunner && classifyStoredFlowManifest(revision.manifest).compatible
  );
}
