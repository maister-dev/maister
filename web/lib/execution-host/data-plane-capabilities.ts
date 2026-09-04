import type { ExecutionHostDataPlaneCapabilities } from "./contracts";

export type ExecutionDataPlaneMode = "legacy_file_v1" | "canonical_events_v1";

// This gate remains false until B3.5 has migrated every control-plane caller;
// capability discovery exists now so supervisor-first and web-first upgrades
// are explicit rather than inferring readiness from a URL or shared volume.
export const CONTROL_PLANE_DATA_PLANE_VERSION: 1 | null = null;

export function selectExecutionDataPlaneMode(
  capabilities: ExecutionHostDataPlaneCapabilities | null,
): ExecutionDataPlaneMode {
  if (
    CONTROL_PLANE_DATA_PLANE_VERSION === 1 &&
    capabilities?.dataPlaneVersion === "execution-host-data-plane.v1" &&
    capabilities.eventStream &&
    capabilities.asyncPrompt &&
    capabilities.runtimeObjects
  ) {
    return "canonical_events_v1";
  }

  return "legacy_file_v1";
}
