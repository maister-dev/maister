import type { ExecutionHostDataPlaneCapabilities } from "./contracts";
import type { ExecutionHost } from "@/lib/db/schema";

import { MaisterError } from "@/lib/errors";

export type ExecutionDataPlaneMode = "canonical_events_v1";

export const CONTROL_PLANE_DATA_PLANE_VERSION = 1;

type DataPlaneSelectionCapabilities = Pick<
  ExecutionHostDataPlaneCapabilities,
  "dataPlaneVersion" | "eventStream" | "asyncPrompt" | "runtimeObjects"
>;

export function selectExecutionDataPlaneMode(
  capabilities: DataPlaneSelectionCapabilities | null,
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

  throw new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    "execution host does not support the required canonical data plane",
    { details: { reason: "data_plane_unsupported" } },
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Host capabilities are durable JSON observed from the supervisor. Re-parse
// the narrow admission predicate rather than trusting a stale or malformed row
// to enable canonical semantics.
export function executionDataPlaneModeForHost(
  host: Pick<ExecutionHost, "capabilities">,
): ExecutionDataPlaneMode {
  const hostCapabilities = record(host.capabilities);
  const dataPlane = record(hostCapabilities?.dataPlane);

  if (
    dataPlane?.version !== "execution-host-data-plane.v1" ||
    typeof dataPlane.eventStream !== "boolean" ||
    typeof dataPlane.asyncPrompt !== "boolean" ||
    typeof dataPlane.runtimeObjects !== "boolean"
  ) {
    return selectExecutionDataPlaneMode(null);
  }

  return selectExecutionDataPlaneMode({
    dataPlaneVersion: dataPlane.version,
    eventStream: dataPlane.eventStream,
    asyncPrompt: dataPlane.asyncPrompt,
    runtimeObjects: dataPlane.runtimeObjects,
  });
}
