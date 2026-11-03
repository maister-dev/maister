import "server-only";

export type CheckpointStopReason =
  | "checkpoint"
  | "no_progress"
  | "repetition"
  | "path_guard"
  | "capability_guard";

/** Positive host evidence of an interrupted prompt, never an inference from
 * elapsed time or a connection-error message. Unsupported resume errors also
 * use CHECKPOINT and deliberately do not satisfy this contract. */
export function checkpointInterruptionReason(
  error: Readonly<Record<string, unknown>>,
): CheckpointStopReason | null {
  if (error.code !== "CHECKPOINT") return null;
  const details = error.details;

  if (!details || typeof details !== "object") return null;
  const fields = details as Readonly<Record<string, unknown>>;

  if (fields.reason !== "session_checkpointed") return null;
  const stopReason = fields.stopReason;

  return stopReason === "checkpoint" ||
    stopReason === "no_progress" ||
    stopReason === "repetition" ||
    stopReason === "path_guard" ||
    stopReason === "capability_guard"
    ? stopReason
    : null;
}
