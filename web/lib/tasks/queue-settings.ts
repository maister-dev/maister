import { z } from "zod";

// ADR-121 §4.3: per-project queue settings. `.strict()` so an unknown key is a
// validation error (room to grow without silently accepting typos). NULL column ⇒
// env defaults apply (resolution lives in `resolveEdgeDrain`/`resolveMaxInFlightAuto`,
// Phase 4). `maxInFlightAuto` is per-project only (absent ⇒ unbounded); `edgeDrain`
// falls back to the env default when absent.
export const taskQueueSettingsSchema = z
  .object({
    edgeDrain: z.boolean().optional(),
    maxInFlightAuto: z.number().int().min(1).optional(),
  })
  .strict();

export type TaskQueueSettings = z.infer<typeof taskQueueSettingsSchema>;

// ADR-121 §4.3 env global defaults (modeled on scheduler `capFromEnv`).
export const DEFAULT_EDGE_DRAIN = true;
export const DEFAULT_AUTO_RESERVE = 2;

function parseEnvBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();

  if (v === "") return fallback;
  if (["on", "true", "1", "yes"].includes(v)) return true;
  if (["off", "false", "0", "no"].includes(v)) return false;

  return fallback;
}

// Non-negative int env reader (the reserve may legitimately be 0 to disable the
// headroom; an invalid value falls back rather than throwing — operability).
function parseEnvNonNegativeInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 0) return fallback;

  return parsed;
}

type QueueSettingsCarrier = { taskQueueSettings?: TaskQueueSettings | null };

// Resolved LIVE at admission (never snapshotted): project override wins, else the
// env default. §4.3.
export function resolveEdgeDrain(project: QueueSettingsCarrier): boolean {
  return (
    project.taskQueueSettings?.edgeDrain ??
    parseEnvBool(process.env.MAISTER_TASK_QUEUE_EDGE_DRAIN, DEFAULT_EDGE_DRAIN)
  );
}

// Flow-pool slots reserved from auto-drain (guaranteed headroom for
// scratch/manual/resume). Global env only — there is no per-project reserve.
export function resolveAutoReserve(): number {
  return parseEnvNonNegativeInt(
    process.env.MAISTER_TASK_QUEUE_AUTO_RESERVE,
    DEFAULT_AUTO_RESERVE,
  );
}

// Per-project cap on concurrently auto-drained flow runs. Absent ⇒ unbounded
// (Infinity), so the global reserve guard is the only C2 bound.
export function resolveMaxInFlightAuto(project: QueueSettingsCarrier): number {
  return project.taskQueueSettings?.maxInFlightAuto ?? Number.POSITIVE_INFINITY;
}
