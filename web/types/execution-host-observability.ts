import type {
  RuntimeEventStreamCloses,
  SupervisorEventStreamHealth,
} from "@/types/platform-status";

export type StreamLagDiagnostic =
  | "host_head_behind_manager"
  | "contiguous_ahead_of_received"
  | "ack_ahead_of_contiguous";

export type StreamLagArithmetic = Readonly<{
  hostToManager: string | null;
  contiguityGap: string | null;
  ackConfirmation: string | null;
  diagnostics: readonly StreamLagDiagnostic[];
}>;

export type ExecutionEventStreamLag = Readonly<{
  streamRowId: string;
  executionHostId: string;
  hostKey: string;
  displayName: string;
  readiness: string;
  readinessReason: string | null;
  hostLastSeenAt: string | null;
  hostBootId: string | null;
  streamId: string;
  streamState: "observed" | "active" | "closed" | "lost";
  lastReceivedSequence: string | null;
  lastContiguousSequence: string | null;
  lastAckConfirmedSequence: string | null;
  streamLastSeenAt: string | null;
  lastError: Record<string, unknown> | null;
  claimOwner: string | null;
  claimExpiresAt: string | null;
  hostTelemetry:
    | (Omit<SupervisorEventStreamHealth, "subscriberPauses" | "closes"> & {
        /** Null when the host did not report subscriber telemetry. */
        subscriberPauses: number | null;
        closes: RuntimeEventStreamCloses | null;
        sampledAt: string;
        bootId: string;
      })
    | null;
  hostTelemetryStatus: "available" | "unsupported" | "unavailable" | "stale";
  hostTelemetryReason: string | null;
  lag: StreamLagArithmetic;
}>;

export type ExecutionConsumerLag = Readonly<{
  consumerName: string;
  runId: string;
  runStatus: string;
  executionHostId: string | null;
  runHorizonSequence: string | null;
  lastRunSequence: string | null;
  backlog: string | null;
  diagnostic: "cursor_ahead_of_horizon" | null;
  lastServedAt: string | null;
  serviceAgeMs: number | null;
  state: "ready" | "retrying" | "poisoned";
  nextRetryAt: string | null;
  latestNodeErrorCode: string | null;
}>;

export type ConsumerLagHostAggregate = Readonly<{
  executionHostId: string | null;
  consumerCount: number;
  maximumBacklog: string;
  diagnosticCount: number;
}>;

export type PoisonedExecutionConsumer = Readonly<{
  consumerName: string;
  runId: string;
  runStatus: string;
  poisonEventId: string | null;
  lastRunSequence: string | null;
  errorEventId: string | null;
  errorGeneration: string | null;
  lastErrorReason: string | null;
}>;

/** Window of `hostSpanSettled1h`, anchored at the read model's `sampledAt`. */
export const HOST_SPAN_SETTLED_WINDOW_HOURS = 1;
/** Window of `hostSpanUnconfirmed` and `postHocConflicts`. Equal to
 * `COMMAND_REPLAY_GRACE_DAYS`: past it the retirement pass reports every
 * still-unbound prompt as `command-terminal-evidence-missing`, so the page and
 * that log together cover a row's whole life. */
export const HOST_SPAN_ANOMALY_WINDOW_DAYS = 7;

/** ADR-167 D5 amendment: one host's prompt commands with
 * `settled_from = 'host_span'` (settled from the host's verified event span
 * before the canonical terminal event was bound), windowed on `completed_at`,
 * the settlement time. A host appears while it is unretired or has a row in
 * the anomaly window, so a zero is a measured zero.
 *
 * - `hostSpanUnconfirmed` — `terminal_event_id IS NULL` and not quarantined:
 *   still waiting for the canonical event to bind.
 * - `postHocConflicts` — `application_error.reason = 'prompt_terminal_conflict'`,
 *   bound or not, applied or not: evidence arriving after the host-span
 *   settlement disagreed and quarantined the row — the canonical event
 *   (`terminal_*`, `event_*`), a replayed receipt (`receipt_*`) or a protocol
 *   check (`*_protocol`); `application_error.causeCode` names which.
 *   Disjoint from `hostSpanUnconfirmed`.
 * - `hostSpanSettled1h` — every host-span settlement in the last hour,
 *   whatever its state: a volume count that overlaps the other two. */
export type HostSpanSettlementCounts = Readonly<{
  executionHostId: string;
  hostKey: string;
  displayName: string;
  hostSpanUnconfirmed: number;
  hostSpanSettled1h: number;
  postHocConflicts: number;
}>;

export type OpenExecutionCommands = Readonly<{
  total: number;
  queued: number;
  delivering: number;
  accepted: number;
  acceptedWithoutTimestamp: number;
  oldestAcceptedAt: string | null;
  oldestAcceptedAgeMs: number | null;
  hostSpan: readonly HostSpanSettlementCounts[];
}>;

export type ExecutionEventLagReadModel = Readonly<{
  sampledAt: string;
  streams: readonly ExecutionEventStreamLag[];
  consumers: Readonly<{
    eligiblePopulation: number;
    totalConsumers: number;
    displayed: number;
    truncated: number;
    maximumBacklog: string;
    diagnosticCount: number;
    byHost: readonly ConsumerLagHostAggregate[];
    top: readonly ExecutionConsumerLag[];
    diagnostics: readonly ExecutionConsumerLag[];
  }>;
  poison: Readonly<{
    total: number;
    displayed: number;
    nextAfter: { runId: string; consumerName: string } | null;
    rows: readonly PoisonedExecutionConsumer[];
  }>;
  commands: OpenExecutionCommands;
}>;
