export class HostRuntimeEventError extends Error {
  readonly reason:
    | "command_in_progress"
    | "command_invariant_conflict"
    | "event_outbox_soft_limit"
    | "event_outbox_hard_limit"
    | "event_outbox_terminal_reserve_exhausted"
    | "stream_identity_conflict"
    | "replay_floor_exceeded"
    | "ack_not_contiguous"
    | "ack_beyond_emitted"
    | "stream_corrupt";

  constructor(reason: HostRuntimeEventError["reason"], message: string) {
    super(message);
    this.name = "HostRuntimeEventError";
    this.reason = reason;
  }
}
