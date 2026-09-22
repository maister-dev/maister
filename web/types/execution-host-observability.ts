import type { SupervisorEventStreamHealth } from "@/types/platform-status";

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
    | (SupervisorEventStreamHealth & {
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

export type OpenExecutionCommands = Readonly<{
  total: number;
  queued: number;
  delivering: number;
  accepted: number;
  acceptedWithoutTimestamp: number;
  oldestAcceptedAt: string | null;
  oldestAcceptedAgeMs: number | null;
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
