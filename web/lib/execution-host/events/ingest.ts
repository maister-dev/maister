import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { ZodError } from "zod";

import type { Db } from "@/lib/execution-host/db";
import {
  RuntimeEventEnvelopeSchema,
  type RuntimeEventEnvelope,
} from "@/lib/execution-host/runtime-events";
import { MaisterError } from "@/lib/errors";
import {
  executionAssignments,
  executionEventIngestFailures,
  executionEvents,
  executionEventStreams,
  executionHosts,
  runs,
} from "@/lib/db/schema";

import { runEventWakeBus } from "./run-wake";

export type RuntimeEventIngestDisposition =
  | "duplicate"
  | "pending_gap"
  | "accepted"
  | "stale_epoch";

export type RuntimeEventIngestResult = {
  disposition: RuntimeEventIngestDisposition;
  eventId: string;
  streamId: string;
  sequence: string;
  contiguousThrough: string | null;
  acceptedCount: number;
  staleEpochCount: number;
  pendingGapCount: number;
};

type IngestedEventRow = {
  id: string;
  runId: string;
  executionAssignmentId: string | null;
  assignmentEpoch: number | null;
  executionHostId: string | null;
  eventStreamId: string | null;
  hostSequence: bigint | null;
  hostBootId: string | null;
  hostSessionId: string | null;
  envelopeVersion: number | null;
  eventType: string;
  payloadSchema: string;
  payload: Record<string, unknown> | null;
  payloadSha256: string | null;
  payloadBytes: number | null;
  occurredAt: Date;
  ingestDisposition: "pending_gap" | "accepted" | "stale_epoch" | "quarantined";
  ingestError: Record<string, unknown> | null;
};

type LockedStream = {
  id: string;
  streamId: string;
  state: "observed" | "active" | "closed" | "lost";
  lastContiguousSequence: bigint | null;
  lastReceivedSequence: bigint | null;
};

const MAX_EVENT_SEQUENCE = 9_223_372_036_854_775_807n;

class StreamIdentityConflictError extends Error {
  constructor(readonly previousStreamId: string) {
    super("execution host changed runtime event stream without reconciliation");
    this.name = "StreamIdentityConflictError";
  }
}

function decimalSequence(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new MaisterError("ACP_PROTOCOL", "runtime event sequence is not canonical", {
      details: { reason: "event_sequence_invalid" },
    });
  }
  const sequence = BigInt(value);
  if (sequence > MAX_EVENT_SEQUENCE) {
    throw new MaisterError("ACP_PROTOCOL", "runtime event sequence exceeds signed BIGINT", {
      details: { reason: "event_sequence_invalid" },
    });
  }
  return sequence;
}

function payloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function encodedPayloadBytes(payload: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

function invariantError(message: string, details: Record<string, unknown>): MaisterError {
  return new MaisterError("CONFLICT", message, { details });
}

async function lockOrCreateStream(
  tx: Db,
  input: { executionHostId: string; envelope: RuntimeEventEnvelope; now: Date },
): Promise<LockedStream> {
  const hosts = await tx
    .select({ id: executionHosts.id, hostKey: executionHosts.hostKey })
    .from(executionHosts)
    .where(eq(executionHosts.id, input.executionHostId))
    .for("update")
    .limit(1);
  const host = hosts[0];
  if (!host) {
    throw new MaisterError("EXECUTOR_UNAVAILABLE", "execution host is not registered");
  }
  if (host.hostKey !== input.envelope.hostKey) {
    throw invariantError("runtime event host identity does not match the selected host", {
      reason: "event_identity_conflict",
      hostId: input.executionHostId,
    });
  }

  const matching = await tx
    .select({
      id: executionEventStreams.id,
      streamId: executionEventStreams.streamId,
      state: executionEventStreams.state,
      lastContiguousSequence: executionEventStreams.lastContiguousSequence,
      lastReceivedSequence: executionEventStreams.lastReceivedSequence,
    })
    .from(executionEventStreams)
    .where(
      and(
        eq(executionEventStreams.executionHostId, input.executionHostId),
        eq(executionEventStreams.streamId, input.envelope.streamId),
      ),
    )
    .for("update")
    .limit(1);
  if (matching[0]) return matching[0] as LockedStream;

  const active = await tx
    .select({ id: executionEventStreams.id, streamId: executionEventStreams.streamId })
    .from(executionEventStreams)
    .where(
      and(
        eq(executionEventStreams.executionHostId, input.executionHostId),
        eq(executionEventStreams.state, "active"),
      ),
    )
    .for("update")
    .limit(1);
  if (active[0]) {
    throw new StreamIdentityConflictError(active[0].streamId);
  }

  const inserted = await tx
    .insert(executionEventStreams)
    .values({
      id: randomUUID(),
      executionHostId: input.executionHostId,
      streamId: input.envelope.streamId,
      state: "active",
      lastBootId: input.envelope.hostBootId,
      lastSeenAt: input.now,
    })
    .onConflictDoNothing({
      target: [
        executionEventStreams.executionHostId,
        executionEventStreams.streamId,
      ],
    })
    .returning({
      id: executionEventStreams.id,
      streamId: executionEventStreams.streamId,
      state: executionEventStreams.state,
      lastContiguousSequence: executionEventStreams.lastContiguousSequence,
      lastReceivedSequence: executionEventStreams.lastReceivedSequence,
    });
  if (inserted[0]) return inserted[0] as LockedStream;

  const raced = await tx
    .select({
      id: executionEventStreams.id,
      streamId: executionEventStreams.streamId,
      state: executionEventStreams.state,
      lastContiguousSequence: executionEventStreams.lastContiguousSequence,
      lastReceivedSequence: executionEventStreams.lastReceivedSequence,
    })
    .from(executionEventStreams)
    .where(
      and(
        eq(executionEventStreams.executionHostId, input.executionHostId),
        eq(executionEventStreams.streamId, input.envelope.streamId),
      ),
    )
    .for("update")
    .limit(1);
  if (!raced[0]) {
    throw new MaisterError("CONFLICT", "runtime event stream registration raced without a durable row");
  }
  return raced[0] as LockedStream;
}

async function resolveAssignment(
  tx: Db,
  input: { executionHostId: string; envelope: RuntimeEventEnvelope },
): Promise<{ id: string | null; current: boolean }> {
  const rows = await tx
    .select({
      id: executionAssignments.id,
      state: executionAssignments.state,
      epoch: executionAssignments.epoch,
      runId: executionAssignments.runId,
      executionHostId: executionAssignments.executionHostId,
    })
    .from(executionAssignments)
    .where(eq(executionAssignments.id, input.envelope.assignmentId))
    .limit(1);
  const assignment = rows[0];
  if (!assignment) return { id: null, current: false };

  const matchesBoundary =
    assignment.runId === input.envelope.runId &&
    assignment.executionHostId === input.executionHostId &&
    assignment.epoch === input.envelope.assignmentEpoch;
  return {
    id: matchesBoundary ? assignment.id : null,
    current: matchesBoundary && assignment.state === "active",
  };
}

async function allocateRunSequence(tx: Db, runId: string): Promise<bigint> {
  const rows = await tx
    .select({ id: runs.id, nextSequence: runs.nextExecutionEventSequence })
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update")
    .limit(1);
  const run = rows[0];
  if (!run) {
    throw new MaisterError("PRECONDITION", "runtime event references an unknown run");
  }
  const next = run.nextSequence;
  await tx
    .update(runs)
    .set({ nextExecutionEventSequence: next + 1n })
    .where(eq(runs.id, run.id));
  return next;
}

async function promoteContiguousPrefix(
  tx: Db,
  input: {
    executionHostId: string;
    stream: LockedStream;
    now: Date;
  },
): Promise<{ contiguousThrough: bigint | null; acceptedCount: number; staleEpochCount: number }> {
  let expected = (input.stream.lastContiguousSequence ?? -1n) + 1n;
  let contiguousThrough = input.stream.lastContiguousSequence;
  let acceptedCount = 0;
  let staleEpochCount = 0;
  const rows = (await tx
    .select({
      id: executionEvents.id,
      runId: executionEvents.runId,
      executionAssignmentId: executionEvents.executionAssignmentId,
      assignmentEpoch: executionEvents.assignmentEpoch,
      executionHostId: executionEvents.executionHostId,
      eventStreamId: executionEvents.eventStreamId,
      hostSequence: executionEvents.hostSequence,
      hostBootId: executionEvents.hostBootId,
      hostSessionId: executionEvents.hostSessionId,
      envelopeVersion: executionEvents.envelopeVersion,
      eventType: executionEvents.eventType,
      payloadSchema: executionEvents.payloadSchema,
      payload: executionEvents.payload,
      payloadSha256: executionEvents.payloadSha256,
      payloadBytes: executionEvents.payloadBytes,
      occurredAt: executionEvents.occurredAt,
      ingestDisposition: executionEvents.ingestDisposition,
      ingestError: executionEvents.ingestError,
    })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.eventStreamId, input.stream.id),
        gte(executionEvents.hostSequence, expected),
      ),
    )
    .orderBy(asc(executionEvents.hostSequence))) as IngestedEventRow[];

  for (const event of rows) {
    if (event.hostSequence !== expected) break;
    if (event.ingestDisposition !== "pending_gap") {
      throw new MaisterError("CONFLICT", "runtime event stream has a non-pending event beyond its watermark");
    }
    const assignment = event.executionAssignmentId
      ? await resolveStoredAssignment(tx, event, input.executionHostId)
      : false;
    if (assignment) {
      const runSequence = await allocateRunSequence(tx, event.runId);
      await tx
        .update(executionEvents)
        .set({ ingestDisposition: "accepted", runSequence })
        .where(eq(executionEvents.id, event.id));
      acceptedCount += 1;
    } else {
      await tx
        .update(executionEvents)
        .set({
          ingestDisposition: "stale_epoch",
          ingestError: {
            ...event.ingestError,
            reason: "stale_assignment_epoch",
          },
        })
        .where(eq(executionEvents.id, event.id));
      staleEpochCount += 1;
    }
    contiguousThrough = expected;
    expected += 1n;
  }

  const firstGap = rows.some((event) => event.hostSequence !== null && event.hostSequence > expected);
  await tx
    .update(executionEventStreams)
    .set({
      state: "active",
      lastContiguousSequence: contiguousThrough,
      firstGapSequence: firstGap ? expected : null,
      gapDetectedAt: firstGap ? input.now : null,
      gapStatus: firstGap ? "open" : null,
      lastSeenAt: input.now,
    })
    .where(eq(executionEventStreams.id, input.stream.id));
  return { contiguousThrough, acceptedCount, staleEpochCount };
}

async function resolveStoredAssignment(
  tx: Db,
  event: IngestedEventRow,
  executionHostId: string,
): Promise<boolean> {
  if (!event.executionAssignmentId || event.assignmentEpoch === null) return false;
  const rows = await tx
    .select({ id: executionAssignments.id })
    .from(executionAssignments)
    .where(
      and(
        eq(executionAssignments.id, event.executionAssignmentId),
        eq(executionAssignments.runId, event.runId),
        eq(executionAssignments.executionHostId, executionHostId),
        eq(executionAssignments.epoch, event.assignmentEpoch),
        eq(executionAssignments.state, "active"),
      ),
    )
    .limit(1);
  return Boolean(rows[0]);
}

async function existingDuplicate(
  tx: Db,
  input: { stream: LockedStream; envelope: RuntimeEventEnvelope; executionHostId: string },
): Promise<boolean> {
  const eventRows = await tx
    .select({
      id: executionEvents.id,
      eventStreamId: executionEvents.eventStreamId,
      hostSequence: executionEvents.hostSequence,
      runId: executionEvents.runId,
      executionHostId: executionEvents.executionHostId,
      executionAssignmentId: executionEvents.executionAssignmentId,
      assignmentEpoch: executionEvents.assignmentEpoch,
      hostBootId: executionEvents.hostBootId,
      hostSessionId: executionEvents.hostSessionId,
      envelopeVersion: executionEvents.envelopeVersion,
      eventType: executionEvents.eventType,
      payloadSchema: executionEvents.payloadSchema,
      payloadSha256: executionEvents.payloadSha256,
      occurredAt: executionEvents.occurredAt,
      ingestError: executionEvents.ingestError,
    })
    .from(executionEvents)
    .where(eq(executionEvents.id, input.envelope.eventId))
    .limit(1);
  const existing = eventRows[0];
  if (existing) {
    const sourceAssignmentId =
      existing.executionAssignmentId ??
      (typeof existing.ingestError?.sourceAssignmentId === "string"
        ? existing.ingestError.sourceAssignmentId
        : null);
    const exact =
      existing.eventStreamId === input.stream.id &&
      existing.hostSequence === decimalSequence(input.envelope.sequence) &&
      existing.runId === input.envelope.runId &&
      existing.executionHostId === input.executionHostId &&
      sourceAssignmentId === input.envelope.assignmentId &&
      existing.assignmentEpoch === input.envelope.assignmentEpoch &&
      existing.hostBootId === input.envelope.hostBootId &&
      existing.hostSessionId === input.envelope.hostSessionId &&
      existing.envelopeVersion === input.envelope.envelopeVersion &&
      existing.eventType === input.envelope.eventType &&
      existing.payloadSchema === input.envelope.payloadSchema &&
      existing.occurredAt.getTime() ===
        new Date(input.envelope.occurredAt).getTime() &&
      existing.payloadSha256 === payloadHash(input.envelope.payload);
    if (!exact) {
      throw invariantError("runtime event id was reused with a different immutable envelope", {
        reason: "event_identity_conflict",
        eventId: input.envelope.eventId,
      });
    }
    return true;
  }
  const positionRows = await tx
    .select({ id: executionEvents.id })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.eventStreamId, input.stream.id),
        eq(executionEvents.hostSequence, decimalSequence(input.envelope.sequence)),
      ),
    )
    .limit(1);
  if (positionRows[0]) {
    throw invariantError("runtime event stream sequence was reused with a different event id", {
      reason: "event_identity_conflict",
      sequence: input.envelope.sequence,
    });
  }
  return false;
}

// This is the only manager write path for host event envelopes. It stores an
// at-least-once delivery exactly once, advances only the contiguous prefix,
// and deliberately records stale epochs without projecting them.
export async function ingestRuntimeEvent(input: {
  db: Db;
  executionHostId: string;
  envelope: unknown;
  now?: Date;
  logger?: Logger;
}): Promise<RuntimeEventIngestResult> {
  const now = input.now ?? new Date();
  let envelope: RuntimeEventEnvelope;
  try {
    envelope = RuntimeEventEnvelopeSchema.parse(input.envelope);
  } catch (error) {
    await recordIngestFailure(input.db, {
      executionHostId: input.executionHostId,
      envelope: input.envelope,
      error,
      now,
    });
    throw new MaisterError("ACP_PROTOCOL", "runtime event envelope is invalid", {
      cause: error,
      details: { reason: "event_schema_invalid" },
    });
  }

  let result: RuntimeEventIngestResult;
  try {
    result = await input.db.transaction(async (tx) => {
    const stream = await lockOrCreateStream(tx, {
      executionHostId: input.executionHostId,
      envelope,
      now,
    });
    const duplicate = await existingDuplicate(tx, {
      stream,
      envelope,
      executionHostId: input.executionHostId,
    });
    if (duplicate) {
      return {
        disposition: "duplicate" as const,
        eventId: envelope.eventId,
        streamId: envelope.streamId,
        sequence: envelope.sequence,
        contiguousThrough: stream.lastContiguousSequence?.toString() ?? null,
        acceptedCount: 0,
        staleEpochCount: 0,
        pendingGapCount: 0,
      };
    }

    const knownRun = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.id, envelope.runId))
      .limit(1);
    if (!knownRun[0]) {
      throw new MaisterError("PRECONDITION", "runtime event references an unknown run");
    }
    const assignment = await resolveAssignment(tx, {
      executionHostId: input.executionHostId,
      envelope,
    });
    const sequence = decimalSequence(envelope.sequence);
    const expected = (stream.lastContiguousSequence ?? -1n) + 1n;
    await tx.insert(executionEvents).values({
      id: envelope.eventId,
      source: "host",
      runId: envelope.runId,
      executionHostId: input.executionHostId,
      eventStreamId: stream.id,
      hostSequence: sequence,
      executionAssignmentId: assignment.id,
      assignmentEpoch: envelope.assignmentEpoch,
      hostBootId: envelope.hostBootId,
      hostSessionId: envelope.hostSessionId,
      envelopeVersion: envelope.envelopeVersion,
      eventType: envelope.eventType,
      payloadSchema: envelope.payloadSchema,
      payload: envelope.payload,
      payloadSha256: payloadHash(envelope.payload),
      payloadBytes: encodedPayloadBytes(envelope.payload),
      occurredAt: new Date(envelope.occurredAt),
      receivedAt: now,
      ingestDisposition: "pending_gap",
      ingestError: assignment.id
        ? null
        : {
            reason: "stale_assignment_epoch",
            sourceAssignmentId: envelope.assignmentId,
          },
    });

    const lastReceived = stream.lastReceivedSequence ?? -1n;
    await tx
      .update(executionEventStreams)
      .set({
        lastReceivedSequence: sequence > lastReceived ? sequence : lastReceived,
        lastBootId: envelope.hostBootId,
        lastSeenAt: now,
      })
      .where(eq(executionEventStreams.id, stream.id));
    await tx
      .update(executionHosts)
      .set({ lastBootId: envelope.hostBootId, lastSeenAt: now, updatedAt: now })
      .where(eq(executionHosts.id, input.executionHostId));

    const promoted = await promoteContiguousPrefix(tx, {
      executionHostId: input.executionHostId,
      stream: {
        ...stream,
        lastContiguousSequence: stream.lastContiguousSequence,
      },
      now,
    });
    const pendingGapCount = sequence > expected ? 1 : 0;
    const disposition =
      sequence > expected
        ? "pending_gap"
        : assignment.current
          ? "accepted"
          : "stale_epoch";
    return {
      disposition,
      eventId: envelope.eventId,
      streamId: envelope.streamId,
      sequence: envelope.sequence,
      contiguousThrough: promoted.contiguousThrough?.toString() ?? null,
      acceptedCount: promoted.acceptedCount,
      staleEpochCount: promoted.staleEpochCount,
      pendingGapCount,
    } satisfies RuntimeEventIngestResult;
    });
  } catch (error) {
    if (error instanceof StreamIdentityConflictError) {
      await markHostUnavailable(input.db, input.executionHostId, now, "event_stream_identity_conflict");
      throw invariantError(error.message, {
        reason: "event_stream_mismatch",
        previousStreamId: error.previousStreamId,
      });
    }
    if (
      error instanceof MaisterError &&
      error.details?.reason === "event_identity_conflict"
    ) {
      await markHostUnavailable(input.db, input.executionHostId, now, "event_identity_conflict");
    }
    throw error;
  }

  input.logger?.info(
    {
      hostId: input.executionHostId,
      streamId: result.streamId,
      eventId: result.eventId,
      sequence: result.sequence,
      disposition: result.disposition,
      contiguousThrough: result.contiguousThrough,
      acceptedCount: result.acceptedCount,
      staleEpochCount: result.staleEpochCount,
    },
    "runtime-event-ingested",
  );
  if (result.acceptedCount > 0) {
    // The durable insert/promotion already committed. This is only a local
    // latency optimization for browser and projector readers.
    runEventWakeBus.wake(envelope.runId);
  }
  return result;
}

async function markHostUnavailable(
  db: Db,
  executionHostId: string,
  now: Date,
  reason: string,
): Promise<void> {
  await db
    .update(executionHosts)
    .set({ readiness: "unavailable", readinessReason: reason, updatedAt: now })
    .where(eq(executionHosts.id, executionHostId));
}

async function recordIngestFailure(
  db: Db,
  input: { executionHostId: string; envelope: unknown; error: unknown; now: Date },
): Promise<void> {
  const candidate = input.envelope && typeof input.envelope === "object"
    ? (input.envelope as Record<string, unknown>)
    : {};
  const eventIdText = typeof candidate.eventId === "string" ? candidate.eventId.slice(0, 128) : "<invalid>";
  const streamId = typeof candidate.streamId === "string" ? candidate.streamId.slice(0, 128) : "<invalid>";
  const sequenceText = typeof candidate.sequence === "string" ? candidate.sequence.slice(0, 32) : "<invalid>";
  const details = input.error instanceof ZodError
    ? { issues: input.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) }
    : { type: input.error instanceof Error ? input.error.name : "unknown" };
  let encodedBytes = 0;
  try {
    encodedBytes = new TextEncoder().encode(JSON.stringify(input.envelope ?? null)).byteLength;
  } catch {
    encodedBytes = 1_048_576;
  }
  await db
    .insert(executionEventIngestFailures)
    .values({
      id: randomUUID(),
      executionHostId: input.executionHostId,
      streamId,
      eventIdText,
      sequenceText,
      reason: "event_schema_invalid",
      details,
      encodedBytes: Math.min(encodedBytes, 1_048_576),
      firstSeenAt: input.now,
      lastSeenAt: input.now,
    })
    .onConflictDoUpdate({
      target: [
        executionEventIngestFailures.executionHostId,
        executionEventIngestFailures.streamId,
        executionEventIngestFailures.eventIdText,
        executionEventIngestFailures.sequenceText,
        executionEventIngestFailures.reason,
      ],
      set: {
        occurrences: sql`${executionEventIngestFailures.occurrences} + 1`,
        lastSeenAt: input.now,
      },
    });
}
