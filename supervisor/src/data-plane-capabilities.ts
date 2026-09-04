import { z } from "zod";

// Additive Stage B discovery starts conservatively. Each feature flips only in
// the task that exposes its complete durable implementation; `/health` stays
// protocol v1 so an old web process remains compatible with a new supervisor.
export const EXECUTION_HOST_DATA_PLANE_VERSION = "execution-host-data-plane.v1";
export const EXECUTION_HOST_CAPABILITY_LIMITS = {
  maxEventBytes: 1_048_576,
  maxObjectBytes: 536_870_912,
  maxReplayBatch: 500,
} as const;

export const ExecutionHostCapabilitiesSchema = z
  .object({
    dataPlaneVersion: z.literal(EXECUTION_HOST_DATA_PLANE_VERSION),
    eventStream: z.boolean(),
    asyncPrompt: z.boolean(),
    runtimeObjects: z.boolean(),
    limits: z
      .object({
        maxEventBytes: z.literal(EXECUTION_HOST_CAPABILITY_LIMITS.maxEventBytes),
        maxObjectBytes: z.literal(EXECUTION_HOST_CAPABILITY_LIMITS.maxObjectBytes),
        maxReplayBatch: z.literal(EXECUTION_HOST_CAPABILITY_LIMITS.maxReplayBatch),
      })
      .strict(),
  })
  .strict();

export type ExecutionHostCapabilities = z.infer<
  typeof ExecutionHostCapabilitiesSchema
>;

export function executionHostCapabilities(): ExecutionHostCapabilities {
  return {
    dataPlaneVersion: EXECUTION_HOST_DATA_PLANE_VERSION,
    eventStream: false,
    asyncPrompt: false,
    runtimeObjects: false,
    limits: EXECUTION_HOST_CAPABILITY_LIMITS,
  };
}
