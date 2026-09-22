import type { DurableWorkerState } from "@/lib/workers/health";
import type {
  ExecutionConsumerLag,
  ExecutionEventLagReadModel,
  OpenExecutionCommands,
  PoisonedExecutionConsumer,
} from "@/types/execution-host-observability";

import {
  isHostBacklogLagEligible,
  LAG_BACKLOG_THRESHOLD,
  LAG_CONSECUTIVE_SWEEPS,
} from "./lag";

const DEFAULT_MAX_SAMPLE_GAP_MS = 120_000;
const MAX_OBSERVATION_BYTES = 65_536;
const CANONICAL_SEQUENCE = /^(0|[1-9][0-9]{0,18})$/;

export type ObservationSourceStatus =
  | "available"
  | "unsupported"
  | "unavailable";

export type LagStreamIdentity = Readonly<{
  executionHostId: string;
  streamId: string;
  bootId: string;
}>;

export type LagObservationSample = Readonly<{
  attemptId: string;
  observerId: string;
  sampledAt: string;
  quality: "complete" | "partial" | "unavailable";
  identity: LagStreamIdentity | null;
  streamState: "observed" | "active" | "closed" | "lost" | null;
  watermarks: Readonly<{
    received: string | null;
    contiguous: string | null;
    acknowledged: string | null;
  }>;
  hostBacklog:
    | Readonly<{
        status: "available";
        unacknowledgedCount: number;
        oldestUnacknowledgedAgeMs: number | null;
      }>
    | Readonly<{ status: "unsupported" | "unavailable" }>;
  projectionBacklog:
    | Readonly<{ status: "available"; maximumBacklog: string }>
    | Readonly<{ status: "unsupported" | "unavailable" }>;
}>;

export type LagObservationTransition = "lagging" | "recovered" | "reset";
export type LagObservationVerdict =
  | "observing"
  | "lagging"
  | "not_advancing"
  | "clear"
  | "unknown"
  | "inactive"
  | "reset";

export type LagStreamObservation = Readonly<{
  attemptId: string;
  observerId: string;
  sampledAt: string;
  identity: LagStreamIdentity | null;
  streamState: LagObservationSample["streamState"];
  watermarks: LagObservationSample["watermarks"];
  hostBacklog: LagObservationSample["hostBacklog"];
  projectionBacklog: LagObservationSample["projectionBacklog"];
  previousSampleId: string | null;
  projectionOverThresholdSince: string | null;
  streak: number;
  incidentOpen: boolean;
  verdict: LagObservationVerdict;
  transition: LagObservationTransition | null;
}>;

export type ExecutionObservabilitySummary = Readonly<{
  schemaVersion: 1;
  attemptId: string;
  observerId: string;
  sampledAt: string;
  quality: "complete" | "partial" | "unavailable";
  errors: readonly string[];
  stream: LagStreamObservation | null;
  consumers: Readonly<{
    status: ObservationSourceStatus;
    total: number;
    maximumBacklog: string;
    truncated?: number;
    top: readonly ExecutionConsumerLag[];
  }>;
  poison: Readonly<{
    status: ObservationSourceStatus;
    total: number;
    truncated?: number;
    rows: readonly PoisonedExecutionConsumer[];
  }>;
  commands: Readonly<
    {
      status: ObservationSourceStatus;
      impasse: number | null;
    } & Partial<OpenExecutionCommands>
  >;
  workers: Readonly<{
    status: ObservationSourceStatus;
    states: Readonly<Record<string, DurableWorkerState>>;
  }>;
}>;

function sameIdentity(
  left: LagStreamIdentity | null,
  right: LagStreamIdentity | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.executionHostId === right.executionHostId &&
    left.streamId === right.streamId &&
    left.bootId === right.bootId
  );
}

function sequence(value: string | null): bigint | null {
  if (value === null) return -1n;
  if (!CANONICAL_SEQUENCE.test(value)) return null;

  return BigInt(value);
}

function hasProgress(
  current: LagObservationSample["watermarks"],
  previous: LagObservationSample["watermarks"],
): boolean {
  const pairs = [
    [current.received, previous.received],
    [current.contiguous, previous.contiguous],
    [current.acknowledged, previous.acknowledged],
  ] as const;

  return pairs.some(([nextValue, priorValue]) => {
    const next = sequence(nextValue);
    const prior = sequence(priorValue);

    return next !== null && prior !== null && next > prior;
  });
}

function projectionThresholdSince(
  sample: LagObservationSample,
  previous: LagStreamObservation | null,
  comparable: boolean,
): string | null {
  if (
    sample.projectionBacklog.status !== "available" ||
    BigInt(sample.projectionBacklog.maximumBacklog) <= LAG_BACKLOG_THRESHOLD
  )
    return null;

  return comparable
    ? (previous?.projectionOverThresholdSince ?? sample.sampledAt)
    : sample.sampledAt;
}

function backlogState(
  sample: LagObservationSample,
  projectionSince: string | null,
  lagAgeMs: number,
): Readonly<{
  eligible: boolean;
  clear: boolean;
}> {
  const sampledAtMs = Date.parse(sample.sampledAt);
  const hostEligible =
    sample.hostBacklog.status === "available" &&
    isHostBacklogLagEligible(sample.hostBacklog, lagAgeMs);
  const projectionEligible =
    projectionSince !== null &&
    sampledAtMs - Date.parse(projectionSince) >= lagAgeMs;
  const clear =
    sample.hostBacklog.status === "available" &&
    sample.projectionBacklog.status === "available" &&
    sample.hostBacklog.unacknowledgedCount <= Number(LAG_BACKLOG_THRESHOLD) &&
    BigInt(sample.projectionBacklog.maximumBacklog) <= LAG_BACKLOG_THRESHOLD;

  return { eligible: hostEligible || projectionEligible, clear };
}

function baseObservation(
  sample: LagObservationSample,
  previous: LagStreamObservation | null,
  projectionOverThresholdSince: string | null,
): Omit<
  LagStreamObservation,
  "streak" | "incidentOpen" | "verdict" | "transition"
> {
  return {
    attemptId: sample.attemptId,
    observerId: sample.observerId,
    sampledAt: sample.sampledAt,
    identity: sample.identity,
    streamState: sample.streamState,
    watermarks: sample.watermarks,
    hostBacklog: sample.hostBacklog,
    projectionBacklog: sample.projectionBacklog,
    previousSampleId: previous?.attemptId ?? null,
    projectionOverThresholdSince,
  };
}

export function reduceLagObservation(
  input: Readonly<{
    sample: LagObservationSample;
    previous: LagStreamObservation | null;
    lagAgeMs: number;
    maxSampleGapMs?: number;
  }>,
): LagStreamObservation {
  const { sample, previous } = input;
  const identityMatches = sameIdentity(
    sample.identity,
    previous?.identity ?? null,
  );
  const projectionSince = projectionThresholdSince(
    sample,
    previous,
    identityMatches,
  );
  const base = baseObservation(sample, previous, projectionSince);

  if (sample.streamState !== "active") {
    return {
      ...base,
      projectionOverThresholdSince: null,
      streak: 0,
      incidentOpen: false,
      verdict: "inactive",
      transition: previous?.incidentOpen ? "reset" : null,
    };
  }

  if (previous === null) {
    return {
      ...base,
      streak: 0,
      incidentOpen: false,
      // An active stream the manager cannot even identify is missing
      // telemetry, not a baseline being established: `observing` claims a
      // first sample was taken, which would be a healthy zero it never saw.
      verdict:
        sample.quality === "complete" && sample.identity !== null
          ? "observing"
          : "unknown",
      transition: null,
    };
  }

  if (sample.quality !== "complete") {
    return {
      ...base,
      identity: previous.identity,
      projectionOverThresholdSince: null,
      streak: 0,
      incidentOpen: previous.incidentOpen,
      verdict: "unknown",
      transition: null,
    };
  }

  if (!identityMatches) {
    return {
      ...base,
      streak: 0,
      incidentOpen: false,
      verdict: "reset",
      transition: previous.incidentOpen ? "reset" : null,
    };
  }

  const sampleGapMs =
    Date.parse(sample.sampledAt) - Date.parse(previous.sampledAt);
  const isFresh =
    sampleGapMs > 0 &&
    sampleGapMs <= (input.maxSampleGapMs ?? DEFAULT_MAX_SAMPLE_GAP_MS);

  if (!isFresh) {
    return {
      ...base,
      projectionOverThresholdSince: null,
      streak: 0,
      incidentOpen: previous.incidentOpen,
      verdict: "unknown",
      transition: null,
    };
  }

  const backlog = backlogState(sample, projectionSince, input.lagAgeMs);

  if (backlog.clear) {
    return {
      ...base,
      projectionOverThresholdSince: null,
      streak: 0,
      incidentOpen: false,
      verdict: "clear",
      transition: previous.incidentOpen ? "recovered" : null,
    };
  }

  if (!hasProgress(sample.watermarks, previous.watermarks)) {
    return {
      ...base,
      streak: 0,
      incidentOpen: previous.incidentOpen,
      verdict: "not_advancing",
      transition: null,
    };
  }

  if (!backlog.eligible) {
    return {
      ...base,
      streak: 0,
      incidentOpen: previous.incidentOpen,
      verdict: "observing",
      transition: null,
    };
  }

  const streak = Math.min(previous.streak + 1, LAG_CONSECUTIVE_SWEEPS);
  const opens = streak === LAG_CONSECUTIVE_SWEEPS && !previous.incidentOpen;

  return {
    ...base,
    streak,
    incidentOpen: previous.incidentOpen || opens,
    verdict: previous.incidentOpen || opens ? "lagging" : "observing",
    transition: opens ? "lagging" : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const VERDICTS: readonly LagObservationVerdict[] = [
  "observing",
  "lagging",
  "not_advancing",
  "clear",
  "unknown",
  "inactive",
  "reset",
];
const TRANSITIONS: readonly LagObservationTransition[] = [
  "lagging",
  "recovered",
  "reset",
];
const STREAM_STATES = ["observed", "active", "closed", "lost"] as const;

function isNullableSequence(value: unknown): boolean {
  return value === null || isNonemptyString(value);
}

function isWatermarks(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNullableSequence(value.received) &&
    isNullableSequence(value.contiguous) &&
    isNullableSequence(value.acknowledged)
  );
}

function isBacklogSource(value: unknown, availableKey: string): boolean {
  if (!isRecord(value)) return false;
  if (value.status === "unsupported" || value.status === "unavailable")
    return true;
  if (value.status !== "available") return false;
  if (availableKey === "maximumBacklog")
    return isNonemptyString(value[availableKey]);

  return (
    typeof value.unacknowledgedCount === "number" &&
    Number.isInteger(value.unacknowledgedCount) &&
    value.unacknowledgedCount >= 0 &&
    (value.oldestUnacknowledgedAgeMs === null ||
      typeof value.oldestUnacknowledgedAgeMs === "number")
  );
}

// Validates EVERY member the reducer later reads. A shallow check let a
// malformed `watermarks` or `projectionOverThresholdSince` through, and the
// reducer then threw on it — surfacing as `lag_collection_failed` (a collector
// fault) instead of `unsupported` (an unreadable prior observation).
function isStreamObservation(value: unknown): value is LagStreamObservation {
  if (!isRecord(value)) return false;
  const identity = value.identity;

  return (
    isNonemptyString(value.attemptId) &&
    isNonemptyString(value.observerId) &&
    isNonemptyString(value.sampledAt) &&
    (identity === null ||
      (isRecord(identity) &&
        isNonemptyString(identity.executionHostId) &&
        isNonemptyString(identity.streamId) &&
        isNonemptyString(identity.bootId))) &&
    (value.streamState === null ||
      STREAM_STATES.includes(
        value.streamState as (typeof STREAM_STATES)[number],
      )) &&
    isWatermarks(value.watermarks) &&
    isBacklogSource(value.hostBacklog, "unacknowledgedCount") &&
    isBacklogSource(value.projectionBacklog, "maximumBacklog") &&
    (value.previousSampleId === null ||
      isNonemptyString(value.previousSampleId)) &&
    (value.projectionOverThresholdSince === null ||
      (isNonemptyString(value.projectionOverThresholdSince) &&
        Number.isFinite(Date.parse(value.projectionOverThresholdSince)))) &&
    typeof value.streak === "number" &&
    Number.isInteger(value.streak) &&
    value.streak >= 0 &&
    value.streak <= LAG_CONSECUTIVE_SWEEPS &&
    typeof value.incidentOpen === "boolean" &&
    VERDICTS.includes(value.verdict as LagObservationVerdict) &&
    (value.transition === null ||
      value.transition === undefined ||
      TRANSITIONS.includes(value.transition as LagObservationTransition))
  );
}

export function parseExecutionObservability(
  value: unknown,
): ExecutionObservabilitySummary | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (
    !isNonemptyString(value.attemptId) ||
    !isNonemptyString(value.observerId) ||
    !isNonemptyString(value.sampledAt) ||
    !["complete", "partial", "unavailable"].includes(String(value.quality)) ||
    !Array.isArray(value.errors) ||
    !value.errors.every((error) => typeof error === "string") ||
    (value.stream !== null && !isStreamObservation(value.stream)) ||
    !isRecord(value.consumers) ||
    !isRecord(value.poison) ||
    !isRecord(value.commands) ||
    !isRecord(value.workers)
  )
    return null;

  return value as ExecutionObservabilitySummary;
}

export function boundExecutionObservability(
  observation: ExecutionObservabilitySummary,
): ExecutionObservabilitySummary {
  const bytes = (value: unknown): number =>
    Buffer.byteLength(JSON.stringify(value), "utf8");

  if (bytes(observation) <= MAX_OBSERVATION_BYTES) return observation;

  const withoutRows: ExecutionObservabilitySummary = {
    ...observation,
    consumers: {
      ...observation.consumers,
      truncated: observation.consumers.total,
      top: [],
    },
    poison: {
      ...observation.poison,
      truncated: observation.poison.total,
      rows: [],
    },
  };

  if (bytes(withoutRows) > MAX_OBSERVATION_BYTES) {
    throw new RangeError("execution observability summary exceeds 64 KiB");
  }

  return withoutRows;
}

function selectedStream(
  model: ExecutionEventLagReadModel,
  previous: LagStreamObservation | null,
) {
  return (
    model.streams.find(
      (stream) =>
        stream.streamState === "active" &&
        stream.hostTelemetryStatus === "available",
    ) ??
    model.streams.find((stream) => stream.streamState === "active") ??
    model.streams.find(
      (stream) =>
        previous?.identity?.executionHostId === stream.executionHostId &&
        previous.identity.streamId === stream.streamId,
    ) ??
    null
  );
}

export function createExecutionObservability(
  input: Readonly<{
    attemptId: string;
    observerId: string;
    model: ExecutionEventLagReadModel;
    previous: LagStreamObservation | null;
    workers: Readonly<Record<string, DurableWorkerState>>;
    impasse: number | null;
    lagAgeMs: number;
    maxSampleGapMs?: number;
  }>,
): ExecutionObservabilitySummary {
  const stream = selectedStream(input.model, input.previous);
  const identity =
    stream !== null && stream.hostBootId !== null
      ? {
          executionHostId: stream.executionHostId,
          streamId: stream.streamId,
          bootId: stream.hostTelemetry?.bootId ?? stream.hostBootId,
        }
      : null;
  const hostBacklog: LagObservationSample["hostBacklog"] =
    stream?.hostTelemetryStatus === "available" && stream.hostTelemetry
      ? {
          status: "available",
          unacknowledgedCount: stream.hostTelemetry.unacknowledgedCount,
          oldestUnacknowledgedAgeMs:
            stream.hostTelemetry.oldestUnacknowledgedAgeMs,
        }
      : {
          status:
            stream?.hostTelemetryStatus === "unsupported"
              ? "unsupported"
              : "unavailable",
        };
  const hostAggregate = input.model.consumers.byHost.find(
    (aggregate) => aggregate.executionHostId === stream?.executionHostId,
  );
  const diagnosticConsumers = hostAggregate?.diagnosticCount ?? 0;
  const measurableConsumers =
    (hostAggregate?.consumerCount ?? 0) - diagnosticConsumers;
  // `maximumBacklog` is MAX over rows with a computable backlog, so a
  // diagnostic consumer is already excluded from it. One inconsistent cursor
  // therefore must NOT blank the whole host's lane — that made an open
  // incident permanently unrecoverable. Only a host whose consumers are ALL
  // diagnostic has nothing left to measure; the diagnostic itself stays
  // visible in `errors` and on the admin page either way.
  const projectionBacklog: LagObservationSample["projectionBacklog"] =
    diagnosticConsumers > 0 && measurableConsumers <= 0
      ? { status: "unavailable" }
      : {
          status: "available",
          maximumBacklog: hostAggregate?.maximumBacklog ?? "0",
        };
  const streamObservation =
    stream === null
      ? null
      : reduceLagObservation({
          sample: {
            attemptId: input.attemptId,
            observerId: input.observerId,
            sampledAt: input.model.sampledAt,
            quality: identity === null ? "partial" : "complete",
            identity,
            streamState: stream.streamState,
            watermarks: {
              received: stream.lastReceivedSequence,
              contiguous: stream.lastContiguousSequence,
              acknowledged: stream.lastAckConfirmedSequence,
            },
            hostBacklog,
            projectionBacklog,
          },
          previous: input.previous,
          lagAgeMs: input.lagAgeMs,
          maxSampleGapMs: input.maxSampleGapMs,
        });
  const errors = (stream?.lag.diagnostics ?? []).map(
    (diagnostic) => `stream:${diagnostic}`,
  );

  if (input.model.consumers.diagnosticCount > 0)
    errors.push("consumer:cursor_ahead_of_horizon");
  const quality: ExecutionObservabilitySummary["quality"] =
    stream === null || identity === null
      ? "unavailable"
      : hostBacklog.status === "available"
        ? "complete"
        : "partial";

  return boundExecutionObservability({
    schemaVersion: 1,
    attemptId: input.attemptId,
    observerId: input.observerId,
    sampledAt: input.model.sampledAt,
    quality,
    errors,
    stream: streamObservation,
    consumers: {
      status: "available",
      total: input.model.consumers.totalConsumers,
      maximumBacklog: input.model.consumers.maximumBacklog,
      truncated: input.model.consumers.truncated,
      top: input.model.consumers.top,
    },
    poison: {
      status: "available",
      total: input.model.poison.total,
      truncated: Math.max(
        0,
        input.model.poison.total - input.model.poison.rows.length,
      ),
      rows: input.model.poison.rows,
    },
    commands: {
      status: "available",
      ...input.model.commands,
      impasse: input.impasse,
    },
    workers: { status: "available", states: input.workers },
  });
}

export function createUnavailableExecutionObservability(
  input: Readonly<{
    attemptId: string;
    observerId: string;
    sampledAt: string;
    previous: LagStreamObservation | null;
    errorCode: string;
    workers: Readonly<Record<string, DurableWorkerState>>;
    impasse: number | null;
    lagAgeMs: number;
    maxSampleGapMs?: number;
  }>,
): ExecutionObservabilitySummary {
  const stream = input.previous
    ? reduceLagObservation({
        sample: {
          attemptId: input.attemptId,
          observerId: input.observerId,
          sampledAt: input.sampledAt,
          quality: "unavailable",
          identity: input.previous.identity,
          streamState: input.previous.streamState,
          watermarks: input.previous.watermarks,
          hostBacklog: { status: "unavailable" },
          projectionBacklog: { status: "unavailable" },
        },
        previous: input.previous,
        lagAgeMs: input.lagAgeMs,
        maxSampleGapMs: input.maxSampleGapMs,
      })
    : null;

  return {
    schemaVersion: 1,
    attemptId: input.attemptId,
    observerId: input.observerId,
    sampledAt: input.sampledAt,
    quality: "unavailable",
    errors: [input.errorCode],
    stream,
    consumers: {
      status: "unavailable",
      total: 0,
      maximumBacklog: "0",
      top: [],
    },
    poison: { status: "unavailable", total: 0, rows: [] },
    commands: { status: "unavailable", impasse: input.impasse },
    workers: { status: "available", states: input.workers },
  };
}
