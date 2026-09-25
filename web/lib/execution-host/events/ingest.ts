import "server-only";

import type { Logger } from "pino";
import type { Db } from "@/lib/execution-host/db";

import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { and, asc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import { ZodError } from "zod";

import { hasNativeOutputCommand } from "../runtime-object-intent";

import { encodeJsonbSafe } from "./jsonb-safe";
import { seedCanonicalProjectionConsumers } from "./projection-consumers";
import { runEventWakeBus } from "./run-wake";

import {
  RuntimeEventEnvelopeSchema,
  SessionContentReferenceSchema,
  StdoutSegmentMetadataSchema,
  type RuntimeEventEnvelope,
} from "@/lib/execution-host/runtime-events";
import { MaisterError } from "@/lib/errors";
import {
  executionAssignments,
  executionEventIngestFailures,
  executionEventSkips,
  executionEvents,
  executionEventStreams,
  executionHosts,
  executionCommands,
  executionRuntimeObjects,
  runs,
} from "@/lib/db/schema";

export type RuntimeEventIngestDisposition =
  | "duplicate"
  | "pending_gap"
  | "accepted"
  | "stale_epoch"
  | "skipped_unknown_run";

export type RuntimeEventIngestResult = {
  disposition: RuntimeEventIngestDisposition;
  eventId: string;
  streamId: string;
  sequence: string;
  contiguousThrough: string | null;
  acceptedCount: number;
  staleEpochCount: number;
  pendingGapCount: number;
  skippedCount: number;
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
  claimOwner: string | null;
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
    throw new MaisterError(
      "ACP_PROTOCOL",
      "runtime event sequence is not canonical",
      {
        details: { reason: "event_sequence_invalid" },
      },
    );
  }
  const sequence = BigInt(value);

  if (sequence > MAX_EVENT_SEQUENCE) {
    throw new MaisterError(
      "ACP_PROTOCOL",
      "runtime event sequence exceeds signed BIGINT",
      {
        details: { reason: "event_sequence_invalid" },
      },
    );
  }

  return sequence;
}

function payloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function encodedPayloadBytes(payload: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

// ADR-167 D5 amendment (D-B4): a host-span reader derives the same stored
// digest and size as ingest, so both feeds verify identical rows.
export {
  payloadHash as runtimeEventPayloadSha256,
  encodedPayloadBytes as runtimeEventPayloadBytes,
};

/** The one envelope normalization: schema parse, then the jsonb-safe escape
 * `execution_events.payload` needs (U+0000 and lone surrogates). */
export function normalizeRuntimeEnvelope(raw: unknown): RuntimeEventEnvelope {
  return encodeJsonbSafe(RuntimeEventEnvelopeSchema.parse(raw));
}

function invariantError(
  message: string,
  details: Record<string, unknown>,
): MaisterError {
  return new MaisterError("CONFLICT", message, { details });
}

async function lockOrCreateStream(
  tx: Db,
  input: { executionHostId: string; envelope: RuntimeEventEnvelope; now: Date },
): Promise<LockedStream> {
  // The host key is immutable, so this is deliberately not FOR UPDATE.
  // Command inserts take FK key-share locks on run/assignment/host rows; an
  // exclusive host lock here followed by the run sequence lock creates the
  // inverse order and can deadlock live event ingest with command admission.
  const hosts = await tx
    .select({ id: executionHosts.id, hostKey: executionHosts.hostKey })
    .from(executionHosts)
    .where(eq(executionHosts.id, input.executionHostId))
    .limit(1);
  const host = hosts[0];

  if (!host) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "execution host is not registered",
    );
  }
  if (host.hostKey !== input.envelope.hostKey) {
    throw invariantError(
      "runtime event host identity does not match the selected host",
      {
        reason: "event_identity_conflict",
        hostId: input.executionHostId,
      },
    );
  }

  const matching = await tx
    .select({
      id: executionEventStreams.id,
      streamId: executionEventStreams.streamId,
      state: executionEventStreams.state,
      lastContiguousSequence: executionEventStreams.lastContiguousSequence,
      lastReceivedSequence: executionEventStreams.lastReceivedSequence,
      claimOwner: executionEventStreams.claimOwner,
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
    .select({
      id: executionEventStreams.id,
      streamId: executionEventStreams.streamId,
    })
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
      claimOwner: executionEventStreams.claimOwner,
    });

  if (inserted[0]) return inserted[0] as LockedStream;

  const raced = await tx
    .select({
      id: executionEventStreams.id,
      streamId: executionEventStreams.streamId,
      state: executionEventStreams.state,
      lastContiguousSequence: executionEventStreams.lastContiguousSequence,
      lastReceivedSequence: executionEventStreams.lastReceivedSequence,
      claimOwner: executionEventStreams.claimOwner,
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
    throw new MaisterError(
      "CONFLICT",
      "runtime event stream registration raced without a durable row",
    );
  }

  return raced[0] as LockedStream;
}

async function resolveAssignment(
  tx: Db,
  input: { executionHostId: string; envelope: RuntimeEventEnvelope },
): Promise<{ id: string | null; accepted: boolean }> {
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

  if (!assignment) return { id: null, accepted: false };

  const matchesBoundary =
    assignment.runId === input.envelope.runId &&
    assignment.executionHostId === input.executionHostId &&
    assignment.epoch === input.envelope.assignmentEpoch;

  if (!matchesBoundary) return { id: null, accepted: false };

  return {
    id: assignment.id,
    accepted:
      assignment.state === "active" ||
      (await isBoundHistoricalEvent(tx, {
        runId: input.envelope.runId,
        executionHostId: input.executionHostId,
        assignmentId: input.envelope.assignmentId,
        assignmentEpoch: input.envelope.assignmentEpoch,
        eventType: input.envelope.eventType,
        payload: input.envelope.payload,
        hostSessionId: input.envelope.hostSessionId,
      })),
  };
}

/** Read-only: the assignment and disposition ingest would give this envelope
 * now, through the same resolver. */
export async function classifyEnvelopeDisposition(
  tx: Db,
  executionHostId: string,
  envelope: RuntimeEventEnvelope,
): Promise<{
  assignmentId: string | null;
  disposition: "accepted" | "stale_epoch";
}> {
  const assignment = await resolveAssignment(tx, { executionHostId, envelope });

  return {
    assignmentId: assignment.id,
    disposition: assignment.accepted ? "accepted" : "stale_epoch",
  };
}

function commandEventIdentity(
  eventType: string,
  payload: Record<string, unknown> | null,
): { commandId: string; kind: string } | null {
  if (
    eventType !== "session.command" ||
    typeof payload?.commandId !== "string" ||
    typeof payload.kind !== "string"
  ) {
    return null;
  }

  return { commandId: payload.commandId, kind: payload.kind };
}

// A host may persist a command receipt/event before the manager commits the
// assignment release, yet deliver that outbox record afterwards. Such an
// event is safe to retain in canonical run order only when its command id,
// kind, run, host, assignment, and epoch all match the durable manager intent.
// It can then settle that historical command, but it cannot address current
// run/session state through a superseded fence.
async function isBoundHistoricalEvent(
  tx: Db,
  input: {
    runId: string;
    executionHostId: string;
    assignmentId: string;
    assignmentEpoch: number;
    hostSessionId: string | null;
    eventType: string;
    payload: Record<string, unknown> | null;
  },
): Promise<boolean> {
  const reference = SessionContentReferenceSchema.safeParse(
    input.payload?.contentRef,
  );
  const segment = StdoutSegmentMetadataSchema.safeParse(
    input.payload?.stdoutSegment,
  );
  const outputCommandId =
    reference.success &&
    input.eventType.startsWith("session.") &&
    reference.data.hostSessionId === input.hostSessionId
      ? reference.data.commandId
      : segment.success && input.eventType === "runtime_object.available"
        ? segment.data.commandId
        : null;

  if (outputCommandId && input.hostSessionId)
    return hasNativeOutputCommand(tx, {
      runId: input.runId,
      executionHostId: input.executionHostId,
      executionAssignmentId: input.assignmentId,
      assignmentEpoch: input.assignmentEpoch,
      commandId: outputCommandId,
      hostSessionId: input.hostSessionId,
    });
  if (
    input.eventType === "runtime_object.available" ||
    input.eventType === "runtime_object.state"
  ) {
    const objectId = input.payload?.objectId;
    const generation = input.payload?.generation;

    if (
      typeof objectId !== "string" ||
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation)
    )
      return false;
    const [intent] = await tx
      .select({ id: executionRuntimeObjects.id })
      .from(executionRuntimeObjects)
      .where(
        and(
          eq(executionRuntimeObjects.id, objectId),
          eq(executionRuntimeObjects.generation, generation),
          eq(executionRuntimeObjects.runId, input.runId),
          eq(executionRuntimeObjects.executionHostId, input.executionHostId),
          eq(executionRuntimeObjects.executionAssignmentId, input.assignmentId),
          eq(executionRuntimeObjects.assignmentEpoch, input.assignmentEpoch),
        ),
      )
      .limit(1);

    return Boolean(intent);
  }
  const identity = commandEventIdentity(input.eventType, input.payload);

  if (!identity) return false;
  const rows = await tx
    .select({
      kind: executionCommands.kind,
      requestSchema: executionCommands.requestSchema,
      requestSha256: executionCommands.requestSha256,
      targetSessionId: executionCommands.targetSessionId,
    })
    .from(executionCommands)
    .where(
      and(
        eq(executionCommands.id, identity.commandId),
        eq(executionCommands.runId, input.runId),
        eq(executionCommands.executionHostId, input.executionHostId),
        eq(executionCommands.executionAssignmentId, input.assignmentId),
        eq(executionCommands.assignmentEpoch, input.assignmentEpoch),
      ),
    )
    .limit(1);

  const command = rows[0];

  if (!command || command.kind !== identity.kind) return false;
  if (command.requestSchema === "maister.command.request.v2")
    return (
      command.targetSessionId === input.hostSessionId &&
      input.payload?.requestSchema === command.requestSchema &&
      input.payload.requestSha256 === command.requestSha256
    );

  return true;
}

/** Sequence positions one contiguity-walk read covers (ADR-167 amendment
 * 2026-09-25). A page is the window `[expected, expected + PROMOTE_READ_ROWS)`:
 * `host_sequence` is unique per stream, so a window holds at most this many
 * rows whatever plan PostgreSQL picks — a LIMIT alone bounds the result, not
 * the scan, and with stale statistics the planner bitmap-scans every pending
 * row and sorts. The window bounds each read, never the promotion: a window
 * walked to its end without a gap reads the next one. */
export const PROMOTE_READ_ROWS = 500;

function pageWindow(streamRowId: string, expected: bigint) {
  return {
    events: and(
      eq(executionEvents.eventStreamId, streamRowId),
      gte(executionEvents.hostSequence, expected),
      lt(executionEvents.hostSequence, expected + BigInt(PROMOTE_READ_ROWS)),
    ),
    skips: and(
      eq(executionEventSkips.eventStreamId, streamRowId),
      gte(executionEventSkips.hostSequence, expected),
      lt(
        executionEventSkips.hostSequence,
        expected + BigInt(PROMOTE_READ_ROWS),
      ),
    ),
  };
}

type PreparedEnvelope = {
  envelope: RuntimeEventEnvelope;
  sequence: bigint;
  payloadSha256: string;
  payloadBytes: number;
};

type WalkResult = {
  contiguousThrough: bigint | null;
  firstGap: bigint | null;
  acceptedCount: number;
  staleEpochCount: number;
  skippedCount: number;
  dispositions: Map<string, "accepted" | "stale_epoch">;
  promotedRunIds: Set<string>;
};

type BatchEntry = {
  result: RuntimeEventIngestResult;
  envelope: RuntimeEventEnvelope;
  quarantined: boolean;
};

type BatchOutcome = {
  streamId: string;
  entries: BatchEntry[];
  contiguousThrough: string | null;
  acceptedCount: number;
  staleEpochCount: number;
  skippedCount: number;
  pendingGapCount: number;
  promotedRunIds: Set<string>;
  claimRenewed: boolean | null;
};

export type RuntimeEventBatchClaim = {
  streamRowId: string;
  owner: string;
  leaseMs: number;
};

export type RuntimeEventBatchResult = {
  streamId: string;
  /** One result per input envelope, in input order. Each carries the batch's
   * totals and watermark; for a batch of one that is the per-event result. */
  results: RuntimeEventIngestResult[];
  contiguousThrough: string | null;
  acceptedCount: number;
  staleEpochCount: number;
  skippedCount: number;
  pendingGapCount: number;
  promotedRunIds: string[];
  /** Null without a claim; false when the locked stream no longer names the
   * claim's owner, so the lease was not renewed. */
  claimRenewed: boolean | null;
};

function prepareEnvelope(envelope: RuntimeEventEnvelope): PreparedEnvelope {
  return {
    envelope,
    sequence: decimalSequence(envelope.sequence),
    payloadSha256: payloadHash(envelope.payload),
    payloadBytes: encodedPayloadBytes(envelope.payload),
  };
}

function sameEnvelope(
  left: PreparedEnvelope,
  right: PreparedEnvelope,
): boolean {
  const a = left.envelope;
  const b = right.envelope;

  return (
    left.sequence === right.sequence &&
    a.streamId === b.streamId &&
    a.hostKey === b.hostKey &&
    a.runId === b.runId &&
    a.assignmentId === b.assignmentId &&
    a.assignmentEpoch === b.assignmentEpoch &&
    a.hostBootId === b.hostBootId &&
    a.hostSessionId === b.hostSessionId &&
    a.envelopeVersion === b.envelopeVersion &&
    a.eventType === b.eventType &&
    a.payloadSchema === b.payloadSchema &&
    new Date(a.occurredAt).getTime() === new Date(b.occurredAt).getTime() &&
    left.payloadSha256 === right.payloadSha256
  );
}

async function lockRuns(
  tx: Db,
  runIds: Iterable<string>,
  locked: Set<string>,
): Promise<Set<string>> {
  const wanted = [...new Set(runIds)].filter((runId) => !locked.has(runId));

  if (wanted.length === 0) return new Set();
  // One statement, ascending id: every writer that can race this one (the
  // owner apply, idle-resume CAS) takes a run lock first, so a peer's order is
  // never inverted inside a batch.
  const rows = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(inArray(runs.id, wanted))
    .orderBy(asc(runs.id))
    .for("update");
  const found = new Set(rows.map((row) => row.id));

  for (const runId of found) locked.add(runId);

  return found;
}

async function applyPromotedPage(
  tx: Db,
  input: {
    executionHostId: string;
    consumed: IngestedEventRow[];
    lockedRuns: Set<string>;
    walk: WalkResult;
  },
): Promise<void> {
  if (input.consumed.length === 0) return;
  const assignmentIds = [
    ...new Set(
      input.consumed.flatMap((event) =>
        event.executionAssignmentId ? [event.executionAssignmentId] : [],
      ),
    ),
  ];
  const assignments = new Map(
    (assignmentIds.length === 0
      ? []
      : await tx
          .select({
            id: executionAssignments.id,
            state: executionAssignments.state,
            epoch: executionAssignments.epoch,
            runId: executionAssignments.runId,
            executionHostId: executionAssignments.executionHostId,
          })
          .from(executionAssignments)
          .where(inArray(executionAssignments.id, assignmentIds))
    ).map((row) => [row.id, row]),
  );
  const accepted: IngestedEventRow[] = [];
  const stale: IngestedEventRow[] = [];

  for (const event of input.consumed) {
    const assignment = event.executionAssignmentId
      ? assignments.get(event.executionAssignmentId)
      : undefined;
    const bound =
      assignment !== undefined &&
      event.assignmentEpoch !== null &&
      assignment.runId === event.runId &&
      assignment.executionHostId === input.executionHostId &&
      assignment.epoch === event.assignmentEpoch &&
      (assignment.state === "active" ||
        (await isBoundHistoricalEvent(tx, {
          runId: event.runId,
          executionHostId: input.executionHostId,
          assignmentId: assignment.id,
          assignmentEpoch: event.assignmentEpoch,
          eventType: event.eventType,
          payload: event.payload,
          hostSessionId: event.hostSessionId,
        })));

    (bound ? accepted : stale).push(event);
  }

  if (accepted.length > 0) {
    // A run first met on a later page than the batch's first pending page is
    // locked here, ascending, before its allocation.
    await lockRuns(
      tx,
      accepted.map((event) => event.runId),
      input.lockedRuns,
    );
    const byRun = new Map<string, IngestedEventRow[]>();

    for (const event of accepted) {
      const rows = byRun.get(event.runId) ?? [];

      rows.push(event);
      byRun.set(event.runId, rows);
    }
    const assigned: Array<{ id: string; runSequence: bigint }> = [];

    for (const runId of [...byRun.keys()].sort()) {
      const rows = byRun.get(runId)!;
      const [allocation] = await tx
        .update(runs)
        .set({
          nextExecutionEventSequence: sql`${runs.nextExecutionEventSequence} + ${rows.length}`,
        })
        .where(eq(runs.id, runId))
        .returning({ next: runs.nextExecutionEventSequence });

      if (!allocation) {
        throw new MaisterError(
          "PRECONDITION",
          "runtime event references an unknown run",
        );
      }
      const first = allocation.next - BigInt(rows.length);

      rows.forEach((event, index) =>
        assigned.push({ id: event.id, runSequence: first + BigInt(index) }),
      );
      input.walk.promotedRunIds.add(runId);
    }
    const values = sql.join(
      assigned.map(
        (row) => sql`(${row.id}::text, ${row.runSequence.toString()}::bigint)`,
      ),
      sql`, `,
    );

    await tx.execute(sql`
      UPDATE execution_events AS e
      SET ingest_disposition = 'accepted', run_sequence = v.run_sequence
      FROM (VALUES ${values}) AS v(id, run_sequence)
      WHERE e.id = v.id`);
    for (const event of accepted)
      input.walk.dispositions.set(event.id, "accepted");
    input.walk.acceptedCount += accepted.length;
  }
  if (stale.length > 0) {
    await tx
      .update(executionEvents)
      .set({
        ingestDisposition: "stale_epoch",
        ingestError: sql`COALESCE(${executionEvents.ingestError}, '{}'::jsonb) || '{"reason":"stale_assignment_epoch"}'::jsonb`,
      })
      .where(
        inArray(
          executionEvents.id,
          stale.map((event) => event.id),
        ),
      );
    for (const event of stale)
      input.walk.dispositions.set(event.id, "stale_epoch");
    input.walk.staleEpochCount += stale.length;
  }
}

// The contiguity walk. It reads pending rows and skip-ledger rows one sequence
// window at a time from the expected sequence and writes NOTHING to the stream
// row: the caller writes the watermark once, with everything else.
async function promoteContiguousPrefix(
  tx: Db,
  input: {
    executionHostId: string;
    streamRowId: string;
    lastContiguousSequence: bigint | null;
    lockedRuns: Set<string>;
  },
): Promise<WalkResult> {
  let expected = (input.lastContiguousSequence ?? -1n) + 1n;
  const walk: WalkResult = {
    contiguousThrough: input.lastContiguousSequence,
    firstGap: null,
    acceptedCount: 0,
    staleEpochCount: 0,
    skippedCount: 0,
    dispositions: new Map(),
    promotedRunIds: new Set(),
  };

  for (;;) {
    const window = pageWindow(input.streamRowId, expected);
    const windowEnd = expected + BigInt(PROMOTE_READ_ROWS);
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
      .where(window.events)
      .orderBy(asc(executionEvents.hostSequence))
      .limit(PROMOTE_READ_ROWS)) as IngestedEventRow[];
    // Sequences this manager deliberately dropped (see executionEventSkips).
    // Without them the walk below would stop at the hole they leave and the
    // stream would never advance again.
    const skipRows = await tx
      .select({ hostSequence: executionEventSkips.hostSequence })
      .from(executionEventSkips)
      .where(window.skips)
      .orderBy(asc(executionEventSkips.hostSequence))
      .limit(PROMOTE_READ_ROWS);
    const skippedSequences = new Set(skipRows.map((row) => row.hostSequence));
    const consumed: IngestedEventRow[] = [];
    let reachedHorizon = false;
    let cursor = 0;

    for (;;) {
      // The window says nothing past its end: read the next one rather than
      // mistake the edge for a gap.
      if (expected === windowEnd) {
        reachedHorizon = true;
        break;
      }
      if (skippedSequences.has(expected)) {
        walk.contiguousThrough = expected;
        expected += 1n;
        walk.skippedCount += 1;
        continue;
      }
      const event = rows[cursor];

      if (!event || event.hostSequence !== expected) break;
      cursor += 1;
      if (event.ingestDisposition !== "pending_gap") {
        throw new MaisterError(
          "CONFLICT",
          "runtime event stream has a non-pending event beyond its watermark",
        );
      }
      consumed.push(event);
      walk.contiguousThrough = expected;
      expected += 1n;
    }
    await applyPromotedPage(tx, {
      executionHostId: input.executionHostId,
      consumed,
      lockedRuns: input.lockedRuns,
      walk,
    });
    if (!reachedHorizon) break;
  }
  // One indexed probe for the gap's existence, ordered so the plan stops at
  // the first row instead of collecting everything held behind the gap.
  const beyond = await tx
    .select({ id: executionEvents.id })
    .from(executionEvents)
    .where(
      and(
        eq(executionEvents.eventStreamId, input.streamRowId),
        gt(executionEvents.hostSequence, expected),
      ),
    )
    .orderBy(asc(executionEvents.hostSequence))
    .limit(1);

  walk.firstGap = beyond[0] ? expected : null;
  for (const runId of walk.promotedRunIds)
    await seedCanonicalProjectionConsumers(tx, runId);

  return walk;
}

function streamWatermarkSet(walk: WalkResult, now: Date) {
  return {
    state: "active" as const,
    lastContiguousSequence: walk.contiguousThrough,
    firstGapSequence: walk.firstGap,
    gapDetectedAt: walk.firstGap === null ? null : now,
    gapStatus: walk.firstGap === null ? null : ("open" as const),
    lastSeenAt: now,
  };
}

function batchResult(
  entry: Omit<
    RuntimeEventIngestResult,
    | "contiguousThrough"
    | "acceptedCount"
    | "staleEpochCount"
    | "pendingGapCount"
    | "skippedCount"
  >,
): RuntimeEventIngestResult {
  return {
    ...entry,
    contiguousThrough: null,
    acceptedCount: 0,
    staleEpochCount: 0,
    pendingGapCount: 0,
    skippedCount: 0,
  };
}

// One transaction per batch, in the order the ADR-167 2026-09-25 amendment
// fixes: stream lock → claim check → duplicate classification → run locks
// (ascending, before any insert) → skips → assignments → one insert → one walk
// → ONE stream-row write and one host-row write. A second update of a row this
// transaction already wrote would re-run its foreign-key checks against
// execution_hosts, which is how a hidden KEY SHARE deadlocks with a peer.
async function ingestPreparedBatch(input: {
  db: Db;
  executionHostId: string;
  items: PreparedEnvelope[];
  claim?: RuntimeEventBatchClaim;
  now: Date;
}): Promise<BatchOutcome> {
  const { items, now } = input;
  const first = items[0]!.envelope;

  return input.db.transaction(async (tx) => {
    const stream = await lockOrCreateStream(tx, {
      executionHostId: input.executionHostId,
      envelope: first,
      now,
    });

    for (const item of items) {
      if (item.envelope.streamId !== first.streamId) {
        throw new MaisterError(
          "CONFLICT",
          "runtime event batch spans more than one host stream",
          { details: { reason: "event_batch_stream_mixed" } },
        );
      }
      if (item.envelope.hostKey !== first.hostKey) {
        throw invariantError(
          "runtime event host identity does not match the selected host",
          {
            reason: "event_identity_conflict",
            hostId: input.executionHostId,
          },
        );
      }
    }
    const claimRenewed = input.claim
      ? stream.id === input.claim.streamRowId &&
        stream.claimOwner === input.claim.owner
      : null;
    const eventIds = [...new Set(items.map((item) => item.envelope.eventId))];
    const skippedIds = new Set(
      (
        await tx
          .select({ eventId: executionEventSkips.eventId })
          .from(executionEventSkips)
          .where(inArray(executionEventSkips.eventId, eventIds))
      ).map((row) => row.eventId),
    );
    const storedIds = eventIds.filter((eventId) => !skippedIds.has(eventId));
    const stored = new Map(
      (storedIds.length === 0
        ? []
        : await tx
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
            .where(inArray(executionEvents.id, storedIds))
      ).map((row) => [row.id, row]),
    );
    const firstOccurrence = new Map<string, PreparedEnvelope>();
    const newPositions = new Map<bigint, string>();
    const kinds: Array<"duplicate" | "new"> = [];
    const fresh: PreparedEnvelope[] = [];

    for (const item of items) {
      const { envelope } = item;
      const earlier = firstOccurrence.get(envelope.eventId);

      if (earlier) {
        // The host replayed the same frame on one connection (the
        // duplicate-frame fault): a duplicate of its first occurrence.
        if (!sameEnvelope(earlier, item)) {
          throw invariantError(
            "runtime event id was reused with a different immutable envelope",
            { reason: "event_identity_conflict", eventId: envelope.eventId },
          );
        }
        kinds.push("duplicate");
        continue;
      }
      firstOccurrence.set(envelope.eventId, item);
      if (skippedIds.has(envelope.eventId)) {
        kinds.push("duplicate");
        continue;
      }
      const existing = stored.get(envelope.eventId);

      if (existing) {
        const sourceAssignmentId =
          existing.executionAssignmentId ??
          (typeof existing.ingestError?.sourceAssignmentId === "string"
            ? existing.ingestError.sourceAssignmentId
            : null);
        const exact =
          existing.eventStreamId === stream.id &&
          existing.hostSequence === item.sequence &&
          existing.runId === envelope.runId &&
          existing.executionHostId === input.executionHostId &&
          sourceAssignmentId === envelope.assignmentId &&
          existing.assignmentEpoch === envelope.assignmentEpoch &&
          existing.hostBootId === envelope.hostBootId &&
          existing.hostSessionId === envelope.hostSessionId &&
          existing.envelopeVersion === envelope.envelopeVersion &&
          existing.eventType === envelope.eventType &&
          existing.payloadSchema === envelope.payloadSchema &&
          existing.occurredAt.getTime() ===
            new Date(envelope.occurredAt).getTime() &&
          existing.payloadSha256 === item.payloadSha256;

        if (!exact) {
          throw invariantError(
            "runtime event id was reused with a different immutable envelope",
            { reason: "event_identity_conflict", eventId: envelope.eventId },
          );
        }
        kinds.push("duplicate");
        continue;
      }
      if (newPositions.has(item.sequence)) {
        throw invariantError(
          "runtime event stream sequence was reused with a different event id",
          { reason: "event_identity_conflict", sequence: envelope.sequence },
        );
      }
      newPositions.set(item.sequence, envelope.eventId);
      kinds.push("new");
      fresh.push(item);
    }
    if (fresh.length > 0) {
      const reused = await tx
        .select({ hostSequence: executionEvents.hostSequence })
        .from(executionEvents)
        .where(
          and(
            eq(executionEvents.eventStreamId, stream.id),
            inArray(
              executionEvents.hostSequence,
              fresh.map((item) => item.sequence),
            ),
          ),
        )
        .limit(1);

      if (reused[0]) {
        throw invariantError(
          "runtime event stream sequence was reused with a different event id",
          {
            reason: "event_identity_conflict",
            sequence: reused[0].hostSequence?.toString() ?? null,
          },
        );
      }
    }
    const expected = (stream.lastContiguousSequence ?? -1n) + 1n;
    const lockedRuns = new Set<string>();
    const knownRuns = new Set<string>();
    const unknown: PreparedEnvelope[] = [];
    const storable: PreparedEnvelope[] = [];

    if (fresh.length > 0) {
      // The first pending page's runs are locked with the batch's own: a row
      // of ANOTHER run held behind the gap this batch fills is promoted — and
      // allocates — in this transaction.
      const pendingRuns = await tx
        .selectDistinct({ runId: executionEvents.runId })
        .from(executionEvents)
        .where(pageWindow(stream.id, expected).events);

      for (const runId of await lockRuns(
        tx,
        [
          ...fresh.map((item) => item.envelope.runId),
          ...pendingRuns.map((row) => row.runId),
        ],
        lockedRuns,
      ))
        knownRuns.add(runId);
      for (const item of fresh)
        (knownRuns.has(item.envelope.runId) ? storable : unknown).push(item);
    }
    if (unknown.length > 0) {
      // Such an event can never become ingestable: execution_events.run_id is
      // a real foreign key and a run id is never created retroactively.
      // Throwing here aborted the transaction, the consumer reconnected, and
      // the replay handed back the same event — so the stream stalled forever
      // and every later event of a LIVE run stayed locked behind it. Record the
      // drop and let the contiguity walk step over it.
      await tx
        .insert(executionEventSkips)
        .values(
          unknown.map((item) => ({
            id: randomUUID(),
            eventStreamId: stream.id,
            executionHostId: input.executionHostId,
            hostSequence: item.sequence,
            eventId: item.envelope.eventId,
            runId: item.envelope.runId,
            eventType: item.envelope.eventType,
            reason: "unknown_run" as const,
            occurredAt: new Date(item.envelope.occurredAt),
          })),
        )
        .onConflictDoNothing();
    }
    const assignments = new Map(
      (storable.length === 0
        ? []
        : await tx
            .select({
              id: executionAssignments.id,
              state: executionAssignments.state,
              epoch: executionAssignments.epoch,
              runId: executionAssignments.runId,
              executionHostId: executionAssignments.executionHostId,
            })
            .from(executionAssignments)
            .where(
              inArray(executionAssignments.id, [
                ...new Set(storable.map((item) => item.envelope.assignmentId)),
              ]),
            )
      ).map((row) => [row.id, row]),
    );
    const boundAssignment = (item: PreparedEnvelope) => {
      const assignment = assignments.get(item.envelope.assignmentId);

      return assignment &&
        assignment.runId === item.envelope.runId &&
        assignment.executionHostId === input.executionHostId &&
        assignment.epoch === item.envelope.assignmentEpoch
        ? assignment
        : null;
    };

    if (storable.length > 0) {
      const inserted = await tx
        .insert(executionEvents)
        .values(
          storable.map((item) => {
            const { envelope } = item;
            const assignment = boundAssignment(item);

            return {
              id: envelope.eventId,
              source: "host" as const,
              runId: envelope.runId,
              executionHostId: input.executionHostId,
              eventStreamId: stream.id,
              hostSequence: item.sequence,
              executionAssignmentId: assignment?.id ?? null,
              assignmentEpoch: envelope.assignmentEpoch,
              hostBootId: envelope.hostBootId,
              hostSessionId: envelope.hostSessionId,
              envelopeVersion: envelope.envelopeVersion,
              eventType: envelope.eventType,
              payloadSchema: envelope.payloadSchema,
              payload: envelope.payload,
              payloadSha256: item.payloadSha256,
              payloadBytes: item.payloadBytes,
              occurredAt: new Date(envelope.occurredAt),
              receivedAt: now,
              ingestDisposition: "pending_gap" as const,
              ingestError: assignment
                ? null
                : {
                    reason: "stale_assignment_epoch",
                    sourceAssignmentId: envelope.assignmentId,
                  },
            };
          }),
        )
        .onConflictDoNothing()
        .returning({ id: executionEvents.id });
      const insertedIds = new Set(inserted.map((row) => row.id));

      // Impossible under the stream lock; asserted rather than absorbed.
      if (
        insertedIds.size !== storable.length ||
        storable.some((item) => !insertedIds.has(item.envelope.eventId))
      ) {
        throw new MaisterError(
          "CONFLICT",
          "runtime event batch insert diverged from its classification",
          {
            details: {
              reason: "event_batch_insert_mismatch",
              expected: storable.length,
              inserted: insertedIds.size,
            },
          },
        );
      }
    }
    const walk =
      fresh.length > 0
        ? await promoteContiguousPrefix(tx, {
            executionHostId: input.executionHostId,
            streamRowId: stream.id,
            lastContiguousSequence: stream.lastContiguousSequence,
            lockedRuns,
          })
        : null;
    const lastFresh = fresh.at(-1)?.envelope;
    const lastStorable = storable.at(-1)?.envelope;
    const receivedBefore = stream.lastReceivedSequence ?? -1n;
    const receivedMax = fresh.reduce(
      (high, item) => (item.sequence > high ? item.sequence : high),
      receivedBefore,
    );

    await tx
      .update(executionEventStreams)
      .set({
        // A duplicate proves the stream is alive even though no watermark
        // moves: without this, a host replaying the same page forever is
        // indistinguishable from an idle one to the stall detector.
        lastSeenAt: now,
        ...(walk && lastFresh
          ? {
              ...streamWatermarkSet(walk, now),
              lastReceivedSequence: receivedMax,
              lastBootId: lastFresh.hostBootId,
            }
          : {}),
        ...(claimRenewed
          ? {
              claimExpiresAt: new Date(now.getTime() + input.claim!.leaseMs),
            }
          : {}),
      })
      .where(eq(executionEventStreams.id, stream.id));
    if (lastStorable) {
      await tx
        .update(executionHosts)
        .set({
          lastBootId: lastStorable.hostBootId,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(executionHosts.id, input.executionHostId));
    }
    const contiguousThrough = walk
      ? walk.contiguousThrough
      : stream.lastContiguousSequence;
    const unknownIds = new Set(unknown.map((item) => item.envelope.eventId));
    const entries: BatchEntry[] = [];
    let pendingGapCount = 0;

    for (const [index, item] of items.entries()) {
      const { envelope } = item;
      let disposition: RuntimeEventIngestDisposition;

      if (kinds[index] === "duplicate") disposition = "duplicate";
      else if (unknownIds.has(envelope.eventId))
        disposition = "skipped_unknown_run";
      else {
        const walked = walk?.dispositions.get(envelope.eventId);

        if (walked) disposition = walked;
        else if (item.sequence >= expected) disposition = "pending_gap";
        else {
          // Below the watermark yet not walked: only a position the skip
          // ledger already covered. Reported as the per-event path always
          // reported it.
          const assignment = boundAssignment(item);

          disposition =
            assignment &&
            (assignment.state === "active" ||
              (await isBoundHistoricalEvent(tx, {
                runId: envelope.runId,
                executionHostId: input.executionHostId,
                assignmentId: envelope.assignmentId,
                assignmentEpoch: envelope.assignmentEpoch,
                eventType: envelope.eventType,
                payload: envelope.payload,
                hostSessionId: envelope.hostSessionId,
              })))
              ? "accepted"
              : "stale_epoch";
        }
        if (disposition === "pending_gap") pendingGapCount += 1;
      }
      entries.push({
        envelope,
        quarantined: false,
        result: batchResult({
          disposition,
          eventId: envelope.eventId,
          streamId: envelope.streamId,
          sequence: envelope.sequence,
        }),
      });
    }

    return {
      streamId: first.streamId,
      entries,
      contiguousThrough: contiguousThrough?.toString() ?? null,
      acceptedCount: walk?.acceptedCount ?? 0,
      staleEpochCount: walk?.staleEpochCount ?? 0,
      skippedCount: walk?.skippedCount ?? 0,
      pendingGapCount,
      promotedRunIds: walk?.promotedRunIds ?? new Set(),
      claimRenewed,
    };
  });
}

// SQLSTATEs a whole batch transaction may fail with and succeed on retry:
// 40P01 deadlock_detected, 40001 serialization_failure, and a connection the
// server reset (08006 / 08003 / 57P01 admin shutdown, ECONNRESET from the
// socket).
const TRANSIENT_CODES = new Set([
  "40P01",
  "40001",
  "08006",
  "08003",
  "57P01",
  "ECONNRESET",
]);

function transientTransactionCode(error: unknown): string | null {
  for (let cause = error, depth = 0; cause && depth < 5; depth += 1) {
    const code = (cause as { code?: unknown }).code;

    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return code;
    cause = (cause as { cause?: unknown }).cause;
  }

  return null;
}

function mergeOutcomes(parts: BatchOutcome[]): BatchOutcome {
  const last = parts.at(-1)!;
  const renewed = parts.map((part) => part.claimRenewed);

  return {
    streamId: last.streamId,
    entries: parts.flatMap((part) => part.entries),
    contiguousThrough: last.contiguousThrough,
    acceptedCount: parts.reduce((sum, part) => sum + part.acceptedCount, 0),
    staleEpochCount: parts.reduce((sum, part) => sum + part.staleEpochCount, 0),
    skippedCount: parts.reduce((sum, part) => sum + part.skippedCount, 0),
    pendingGapCount: parts.reduce((sum, part) => sum + part.pendingGapCount, 0),
    promotedRunIds: new Set(parts.flatMap((part) => [...part.promotedRunIds])),
    claimRenewed: renewed.includes(false)
      ? false
      : renewed.includes(true)
        ? true
        : null,
  };
}

async function ingestWithRecovery(input: {
  db: Db;
  executionHostId: string;
  items: PreparedEnvelope[];
  claim?: RuntimeEventBatchClaim;
  now: Date;
  logger?: Logger;
}): Promise<BatchOutcome> {
  const attempt = async (): Promise<BatchOutcome> => {
    try {
      return await ingestPreparedBatch(input);
    } catch (error) {
      const sqlState = transientTransactionCode(error);

      if (!sqlState) throw error;
      input.logger?.warn(
        {
          hostId: input.executionHostId,
          streamId: input.items[0]!.envelope.streamId,
          size: input.items.length,
          sqlState,
        },
        "runtime-event-batch-retried",
      );
      await delay(25 + Math.floor(Math.random() * 50));

      return ingestPreparedBatch(input);
    }
  };

  try {
    return await attempt();
  } catch (error) {
    if (error instanceof StreamIdentityConflictError) {
      await markHostUnavailable(
        input.db,
        input.executionHostId,
        input.now,
        "event_stream_identity_conflict",
      );
      throw invariantError(error.message, {
        reason: "event_stream_mismatch",
        previousStreamId: error.previousStreamId,
      });
    }
    if (
      error instanceof MaisterError &&
      error.details?.reason === "event_identity_conflict"
    ) {
      await markHostUnavailable(
        input.db,
        input.executionHostId,
        input.now,
        "event_identity_conflict",
      );
    }
    const sqlState = unstorablePayloadCode(error);

    if (!sqlState) throw error;
    if (input.items.length > 1) {
      // PostgreSQL refused a payload somewhere in the batch and committed
      // nothing. Re-run the same envelopes one at a time, in order, through
      // this same path: the refused one alone reaches the quarantine below.
      input.logger?.warn(
        {
          hostId: input.executionHostId,
          streamId: input.items[0]!.envelope.streamId,
          size: input.items.length,
          sqlState,
        },
        "runtime-event-batch-split",
      );
      const parts: BatchOutcome[] = [];

      for (const item of input.items)
        parts.push(await ingestWithRecovery({ ...input, items: [item] }));

      return mergeOutcomes(parts);
    }

    // PostgreSQL refuses this payload outright, so no retry can ever succeed
    // and rethrowing would park the contiguity walk on it forever — the exact
    // shape that stopped the platform for 15 h on 2026-09-16. Drop it into the
    // skip ledger, on the same terms as an event for an unknown run.
    return quarantineUnstorableEvent({
      db: input.db,
      executionHostId: input.executionHostId,
      envelope: input.items[0]!.envelope,
      sqlState,
      now: input.now,
      logger: input.logger,
    });
  }
}

// This is the only manager write path for host event envelopes. It stores an
// at-least-once delivery exactly once, advances only the contiguous prefix,
// and deliberately records stale epochs without projecting them. A batch
// commits whole or not at all (ADR-167 amendment 2026-09-25).
export async function ingestRuntimeEventBatch(input: {
  db: Db;
  executionHostId: string;
  envelopes: readonly unknown[];
  claim?: RuntimeEventBatchClaim;
  now?: Date;
  logger?: Logger;
}): Promise<RuntimeEventBatchResult> {
  const startedAt = performance.now();
  const now = input.now ?? new Date();

  if (input.envelopes.length === 0) {
    throw new MaisterError("PRECONDITION", "runtime event batch is empty");
  }
  const items: PreparedEnvelope[] = [];

  for (const [index, raw] of input.envelopes.entries()) {
    let envelope: RuntimeEventEnvelope;

    try {
      // `execution_events.payload` is jsonb, which cannot hold U+0000 or a
      // lone surrogate. Escaping here — before the identity hash, the
      // duplicate probe and the insert all read it — keeps every derived value
      // describing the same stored bytes. Readers restore the original through
      // decodeJsonbSafe.
      envelope = normalizeRuntimeEnvelope(raw);
    } catch (error) {
      // The frames before it arrived intact: commit them first.
      if (index > 0)
        await ingestRuntimeEventBatch({
          ...input,
          envelopes: input.envelopes.slice(0, index),
        });
      await recordIngestFailure(input.db, {
        executionHostId: input.executionHostId,
        envelope: raw,
        error,
        now,
      });
      throw new MaisterError(
        "ACP_PROTOCOL",
        "runtime event envelope is invalid",
        {
          cause: error,
          details: { reason: "event_schema_invalid" },
        },
      );
    }
    items.push(prepareEnvelope(envelope));
  }

  const outcome = await ingestWithRecovery({
    db: input.db,
    executionHostId: input.executionHostId,
    items,
    claim: input.claim,
    now,
    logger: input.logger,
  });
  const results = outcome.entries.map((entry) => ({
    ...entry.result,
    contiguousThrough: outcome.contiguousThrough,
    acceptedCount: outcome.acceptedCount,
    staleEpochCount: outcome.staleEpochCount,
    pendingGapCount: outcome.pendingGapCount,
    skippedCount: outcome.skippedCount,
  }));
  const counts = {
    accepted: 0,
    duplicates: 0,
    staleEpochs: 0,
    skipped: 0,
    pendingGaps: 0,
  };

  for (const [index, entry] of outcome.entries.entries()) {
    const result = results[index]!;

    if (result.disposition === "accepted") counts.accepted += 1;
    else if (result.disposition === "duplicate") counts.duplicates += 1;
    else if (result.disposition === "stale_epoch") counts.staleEpochs += 1;
    else if (result.disposition === "skipped_unknown_run") counts.skipped += 1;
    else counts.pendingGaps += 1;
    if (entry.quarantined) continue;
    if (result.disposition === "skipped_unknown_run") {
      input.logger?.warn(
        {
          hostId: input.executionHostId,
          streamId: result.streamId,
          eventId: result.eventId,
          sequence: result.sequence,
          runId: entry.envelope.runId,
          eventType: entry.envelope.eventType,
          contiguousThrough: result.contiguousThrough,
        },
        "runtime-event-skipped-unknown-run",
      );
    }
    // Per event only where it is diagnostic: an accepted event is the
    // high-volume case and is covered by the batch line below.
    input.logger?.[result.disposition === "accepted" ? "debug" : "info"](
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
  }
  input.logger?.info(
    {
      hostId: input.executionHostId,
      streamId: outcome.streamId,
      received: items.length,
      ...counts,
      firstSequence: items[0]!.envelope.sequence,
      lastSequence: items.at(-1)!.envelope.sequence,
      contiguousThrough: outcome.contiguousThrough,
      promotedRuns: outcome.promotedRunIds.size,
      batchMs: Math.round(performance.now() - startedAt),
    },
    "runtime-event-batch-ingested",
  );
  // The durable insert/promotion already committed. This is only a local
  // latency optimization for browser and projector readers.
  for (const runId of outcome.promotedRunIds) runEventWakeBus.wake(runId);

  return {
    streamId: outcome.streamId,
    results,
    contiguousThrough: outcome.contiguousThrough,
    acceptedCount: outcome.acceptedCount,
    staleEpochCount: outcome.staleEpochCount,
    skippedCount: outcome.skippedCount,
    pendingGapCount: outcome.pendingGapCount,
    promotedRunIds: [...outcome.promotedRunIds],
    claimRenewed: outcome.claimRenewed,
  };
}

/** A batch of one: the same write path, so every per-event caller pins it. */
export async function ingestRuntimeEvent(input: {
  db: Db;
  executionHostId: string;
  envelope: unknown;
  now?: Date;
  logger?: Logger;
}): Promise<RuntimeEventIngestResult> {
  const batch = await ingestRuntimeEventBatch({
    db: input.db,
    executionHostId: input.executionHostId,
    envelopes: [input.envelope],
    now: input.now,
    logger: input.logger,
  });

  return batch.results[0]!;
}

// SQLSTATEs PostgreSQL raises for a value it cannot represent at all:
// 22P05 unsupported_character_value (a NUL or lone surrogate reaching jsonb),
// 22P02 invalid_text_representation, 22021 character_not_in_repertoire. None of
// them is retryable — the same bytes fail identically every time.
const UNSTORABLE_SQLSTATES = new Set(["22P05", "22P02", "22021"]);

function unstorablePayloadCode(error: unknown): string | null {
  for (let cause = error, depth = 0; cause && depth < 5; depth += 1) {
    const code = (cause as { code?: unknown }).code;

    if (typeof code === "string" && UNSTORABLE_SQLSTATES.has(code)) return code;
    cause = (cause as { cause?: unknown }).cause;
  }

  return null;
}

async function quarantineUnstorableEvent(input: {
  db: Db;
  executionHostId: string;
  envelope: RuntimeEventEnvelope;
  sqlState: string;
  now: Date;
  logger?: Logger;
}): Promise<BatchOutcome> {
  const { envelope, now } = input;
  const sequence = decimalSequence(envelope.sequence);
  const outcome = await input.db.transaction(async (tx) => {
    const stream = await lockOrCreateStream(tx, {
      executionHostId: input.executionHostId,
      envelope,
      now,
    });

    await tx
      .insert(executionEventSkips)
      .values({
        id: randomUUID(),
        eventStreamId: stream.id,
        executionHostId: input.executionHostId,
        hostSequence: sequence,
        eventId: envelope.eventId,
        runId: envelope.runId,
        eventType: envelope.eventType,
        reason: "payload_unstorable",
        occurredAt: new Date(envelope.occurredAt),
      })
      .onConflictDoNothing();

    const walk = await promoteContiguousPrefix(tx, {
      executionHostId: input.executionHostId,
      streamRowId: stream.id,
      lastContiguousSequence: stream.lastContiguousSequence,
      lockedRuns: new Set(),
    });
    const lastReceived = stream.lastReceivedSequence ?? -1n;

    await tx
      .update(executionEventStreams)
      .set({
        ...streamWatermarkSet(walk, now),
        lastReceivedSequence: sequence > lastReceived ? sequence : lastReceived,
        lastBootId: envelope.hostBootId,
      })
      .where(eq(executionEventStreams.id, stream.id));

    return {
      streamId: envelope.streamId,
      entries: [
        {
          envelope,
          quarantined: true,
          result: batchResult({
            disposition: "skipped_unknown_run",
            eventId: envelope.eventId,
            streamId: envelope.streamId,
            sequence: envelope.sequence,
          }),
        },
      ],
      contiguousThrough: walk.contiguousThrough?.toString() ?? null,
      acceptedCount: walk.acceptedCount,
      staleEpochCount: walk.staleEpochCount,
      skippedCount: walk.skippedCount,
      pendingGapCount: 0,
      promotedRunIds: walk.promotedRunIds,
      claimRenewed: null,
    } satisfies BatchOutcome;
  });

  await recordIngestFailure(input.db, {
    executionHostId: input.executionHostId,
    envelope,
    error: new Error(`payload rejected by PostgreSQL (${input.sqlState})`),
    now,
    reason: "event_payload_unstorable",
  });
  input.logger?.warn(
    {
      hostId: input.executionHostId,
      streamId: outcome.streamId,
      eventId: envelope.eventId,
      sequence: envelope.sequence,
      runId: envelope.runId,
      eventType: envelope.eventType,
      sqlState: input.sqlState,
      contiguousThrough: outcome.contiguousThrough,
    },
    "runtime-event-payload-unstorable",
  );

  return outcome;
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
  input: {
    executionHostId: string;
    envelope: unknown;
    error: unknown;
    now: Date;
    reason?: string;
  },
): Promise<void> {
  const candidate =
    input.envelope && typeof input.envelope === "object"
      ? (input.envelope as Record<string, unknown>)
      : {};
  const eventIdText =
    typeof candidate.eventId === "string"
      ? candidate.eventId.slice(0, 128)
      : "<invalid>";
  const streamId =
    typeof candidate.streamId === "string"
      ? candidate.streamId.slice(0, 128)
      : "<invalid>";
  const sequenceText =
    typeof candidate.sequence === "string"
      ? candidate.sequence.slice(0, 32)
      : "<invalid>";
  const details =
    input.error instanceof ZodError
      ? {
          issues: input.error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
          })),
        }
      : { type: input.error instanceof Error ? input.error.name : "unknown" };
  let encodedBytes = 0;

  try {
    encodedBytes = new TextEncoder().encode(
      JSON.stringify(input.envelope ?? null),
    ).byteLength;
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
      reason: input.reason ?? "event_schema_invalid",
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
