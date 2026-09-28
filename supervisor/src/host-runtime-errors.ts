export class HostRuntimeEventError extends Error {
  readonly reason:
    | "runtime_storage_unavailable"
    | "runtime_storage_pressure"
    | "command_in_progress"
    | "command_invariant_conflict"
    | "event_outbox_soft_limit"
    | "event_outbox_hard_limit"
    | "event_outbox_physical_limit"
    | "event_outbox_terminal_reserve_exhausted"
    | "event_outbox_wallet_exhausted"
    | "stream_identity_conflict"
    | "replay_floor_exceeded"
    | "ack_not_contiguous"
    | "ack_beyond_emitted"
    | "stream_corrupt";

  constructor(
    reason: HostRuntimeEventError["reason"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostRuntimeEventError";
    this.reason = reason;
  }
}

// ADR-183 amendment 2026-09-28: every outbox refusal travels as the one wire
// token `event_outbox_backpressure`; this names which limit refused it, so the
// manager can tell a host that refuses new work from a per-command refusal.
export const OUTBOX_LIMITS = [
  "unacknowledged",
  "retained",
  "physical",
  "control",
  "wallet",
] as const;

export type OutboxLimit = (typeof OUTBOX_LIMITS)[number];

// The host-wide limits `GET /health` can report, in admission order; `wallet`
// is per-command and never refuses new work host-wide.
export const NEW_WORK_REFUSALS = [
  "physical",
  "unacknowledged",
  "retained",
  "control",
] as const satisfies readonly OutboxLimit[];

export type NewWorkRefusal = (typeof NEW_WORK_REFUSALS)[number];

// Exhaustive, so a new reason cannot reach the wire unclassified.
const OUTBOX_LIMIT_BY_REASON: Record<
  HostRuntimeEventError["reason"],
  OutboxLimit | null
> = {
  runtime_storage_unavailable: null,
  runtime_storage_pressure: null,
  command_in_progress: null,
  command_invariant_conflict: null,
  event_outbox_soft_limit: "unacknowledged",
  event_outbox_hard_limit: "retained",
  event_outbox_physical_limit: "physical",
  event_outbox_terminal_reserve_exhausted: "control",
  event_outbox_wallet_exhausted: "wallet",
  stream_identity_conflict: null,
  replay_floor_exceeded: null,
  ack_not_contiguous: null,
  ack_beyond_emitted: null,
  stream_corrupt: null,
};

export function outboxLimitOf(
  reason: HostRuntimeEventError["reason"],
): OutboxLimit | null {
  return OUTBOX_LIMIT_BY_REASON[reason];
}
