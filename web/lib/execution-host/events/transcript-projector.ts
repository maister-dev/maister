import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionEventProjector } from "./projector";
import type { SQL } from "drizzle-orm";
import type { CompactionMarker } from "@/lib/run-transcript/compaction";

import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import pino from "pino";

import {
  acpContextUpdateType,
  clipCompactionText,
  MAX_COMPACTION_SUMMARY_LENGTH,
} from "../../../../runtime/acp-context";

import { CANONICAL_PROJECTION_CONSUMERS } from "./projection-consumers";
import { isProjectionTransactionUnavailable } from "./projection-transaction";
import { ExecutionEventProjectionError } from "./projector";
import { lockTranscriptState, transcriptStateId } from "./run-message-store";
import {
  isPrunedContextEvent,
  prepareTranscriptContent,
  readAcpContextUpdate,
} from "./session-content";
import { decodeJsonbSafe, encodeJsonbSafe } from "./jsonb-safe";
import { advanceCompactionTranscriptRevision } from "./compaction-revisions";
import { runEventWakeBus } from "./run-wake";

import { parseCompactionMarker } from "@/lib/run-transcript/compaction";
import {
  nodeAttempts,
  runMessages,
  runs,
  runTranscriptStates,
  type ExecutionEvent,
} from "@/lib/db/schema";
import {
  encodeThoughtPayload,
  encodeToolPayload,
  encodeUsagePayload,
  interpretSessionUpdate,
} from "@/lib/run-transcript/transcript";
import { pgErrorOf } from "@/lib/db/pg-error";
import { MaisterError } from "@/lib/errors";

const logger = pino({
  name: "transcript-projector",
  level: process.env.LOG_LEVEL ?? "info",
});

const RESET_EVENTS = new Set([
  "session.permission_request",
  "session.hook_trip",
  "session.exited",
  "session.crashed",
]);

async function projectSingleWithUnstorableMapping(
  tx: Db,
  event: ExecutionEvent,
): Promise<void> {
  try {
    await projectTranscriptEvent(tx, event);
  } catch (error) {
    // This projector round-trips message bodies through `::jsonb` so the
    // concatenation stays in PostgreSQL. A value jsonb cannot represent
    // therefore fails HERE, deterministically — but as a raw driver error it
    // was classified transient, burned five retries, and landed as
    // `unexpected_error` with no hint of its cause. Name it: a deterministic
    // failure poisons at once, which is what the operator repair path expects.
    const sqlState = unstorableSqlState(error);

    if (sqlState)
      throw new ExecutionEventProjectionError(
        `transcript content cannot be represented in jsonb (${sqlState})`,
        true,
      );
    throw error;
  }
}

export const canonicalTranscriptProjector: ExecutionEventProjector = {
  consumerName: CANONICAL_PROJECTION_CONSUMERS.transcript,
  prepare: prepareTranscriptContent,
  afterCommit(events) {
    const relevant = events.find((event) => {
      const type = acpContextUpdateType(event.payload?.update);

      return (
        type === "compaction_update" ||
        type === "compaction_summary_chunk" ||
        event.eventType === "session.exited" ||
        event.eventType === "session.crashed"
      );
    });

    if (relevant) runEventWakeBus.wake(relevant.runId);
  },
  project: projectSingleWithUnstorableMapping,
  projectBatch: projectTranscriptBatch,
};

function compactionSessionPrefix(event: ExecutionEvent): string {
  const scope = [
    event.executionHostId,
    event.executionAssignmentId,
    event.assignmentEpoch,
    event.hostSessionId,
  ];

  return `compaction:${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}:`;
}

// Both old and current marker writers serialize version, kind and status first.
// Older summary text can contain JSON escapes for lone surrogates, so avoid
// casting the whole row to jsonb just to find the still-open markers.
const OPEN_COMPACTION_HEADER =
  '{"v":1,"kind":"compaction","status":"in_progress"';

async function interruptTranscriptCompactions(
  tx: Db,
  event: ExecutionEvent,
  sequence: bigint,
): Promise<void> {
  const open = await tx
    .select({
      id: runMessages.id,
      nodeAttemptId: runMessages.nodeAttemptId,
      content: runMessages.content,
    })
    .from(runMessages)
    .where(
      and(
        eq(runMessages.runId, event.runId),
        sql`${runMessages.projectionToolKey} LIKE ${`${compactionSessionPrefix(event)}%`}`,
        sql`starts_with(${runMessages.content}, ${OPEN_COMPACTION_HEADER})`,
      ),
    );
  const attempts = new Set<string | null>();

  for (const row of open) {
    const marker = parseCompactionMarker(
      decodeJsonbSafe(JSON.parse(row.content)),
    );

    if (marker?.status !== "in_progress") continue;
    await tx
      .update(runMessages)
      .set({
        content: JSON.stringify(
          encodeJsonbSafe({ ...marker, status: "interrupted" }),
        ),
        supervisorEventId: sequence.toString(),
      })
      .where(eq(runMessages.id, row.id));
    attempts.add(row.nodeAttemptId);
  }
  for (const attempt of attempts)
    await advanceCompactionTranscriptRevision(
      tx,
      event.runId,
      attempt,
      sequence,
    );
}

// 22P05 unsupported_character_value, 22P02 invalid_text_representation,
// 22021 character_not_in_repertoire. None can succeed on a retry.
const UNSTORABLE_SQLSTATES = new Set(["22P05", "22P02", "22021"]);

// Transaction-wide cancellation, timeout, contention, or aborted-tx states
// must never be swallowed into a 100-event sequential replay.
const NON_REPLAYABLE_BATCH_SQLSTATES = new Set([
  "57014", // query_canceled / statement_timeout
  "55P03", // lock_not_available / lock_timeout
  "40P01", // deadlock_detected
  "40001", // serialization_failure
  "25P02", // in_failed_sql_transaction
]);

function isNonReplayableBatchError(error: unknown): boolean {
  if (isProjectionTransactionUnavailable(error)) return true;
  if (error instanceof MaisterError && error.code === "EXECUTOR_UNAVAILABLE")
    return true;
  const code = pgErrorOf(error)?.code;

  return (
    typeof code === "string" &&
    (NON_REPLAYABLE_BATCH_SQLSTATES.has(code) ||
      code.startsWith("08") ||
      code.startsWith("57"))
  );
}

type CompactionContextUpdate = Extract<
  NonNullable<ReturnType<typeof readAcpContextUpdate>>,
  { kind: "compaction" | "summary_chunk" }
>;

async function applyCompactionUpdate(input: {
  tx: Db;
  runId: string;
  nodeAttemptId: string | null;
  event: ExecutionEvent;
  update: CompactionContextUpdate;
  onInsert: (content: string, key: string) => Promise<void>;
  onExistingUpdate?: () => void;
}): Promise<boolean> {
  const { tx, runId, nodeAttemptId, event, update, onInsert } = input;
  const eventId = event.runSequence!.toString();
  const key =
    compactionSessionPrefix(event) +
    createHash("sha256").update(update.id).digest("hex");
  const [existing] = await tx
    .select({
      id: runMessages.id,
      nodeAttemptId: runMessages.nodeAttemptId,
      content: runMessages.content,
      lastEventId: runMessages.supervisorEventId,
    })
    .from(runMessages)
    .where(
      and(eq(runMessages.runId, runId), eq(runMessages.projectionToolKey, key)),
    )
    .limit(1);

  if (
    existing?.lastEventId &&
    BigInt(existing.lastEventId) >= event.runSequence!
  )
    return false;
  const stored: unknown = existing
    ? decodeJsonbSafe(JSON.parse(existing.content))
    : null;
  const previous = parseCompactionMarker(stored);
  const summaryAtLimit =
    stored !== null &&
    typeof stored === "object" &&
    "summaryTruncated" in stored &&
    stored.summaryTruncated === true;

  if (
    update.kind === "summary_chunk" &&
    (previous?.status !== "in_progress" || summaryAtLimit)
  )
    return false;
  if (
    previous &&
    previous.status !== "in_progress" &&
    update.kind === "compaction" &&
    previous.status !== update.status
  )
    return false;
  const summary =
    update.kind === "summary_chunk"
      ? (previous?.summary ?? "") + update.text
      : update.summary;
  const marker: CompactionMarker & { summaryTruncated?: true } = {
    ...previous,
    v: 1,
    kind: "compaction",
    status: update.kind === "compaction" ? update.status : "in_progress",
    ...(summary !== undefined
      ? {
          summary: clipCompactionText(summary, MAX_COMPACTION_SUMMARY_LENGTH),
        }
      : {}),
    ...(update.kind === "compaction" && update.error !== undefined
      ? { error: update.error }
      : {}),
    ...((
      summary === undefined
        ? summaryAtLimit
        : summary.length >= MAX_COMPACTION_SUMMARY_LENGTH
    )
      ? { summaryTruncated: true }
      : {}),
  };
  const content = JSON.stringify(encodeJsonbSafe(marker));

  if (existing) {
    input.onExistingUpdate?.();
    await tx
      .update(runMessages)
      .set({
        content,
        supervisorEventId: eventId,
      })
      .where(eq(runMessages.id, existing.id));
  } else {
    await onInsert(content, key);
  }
  await advanceCompactionTranscriptRevision(
    tx,
    runId,
    existing ? existing.nodeAttemptId : nodeAttemptId,
    event.runSequence!,
  );

  return true;
}

// A scratch turn boundary: the point after which no open text or thought row
// may be continued, and the usage row starts again.
const SCRATCH_BOUNDARY_EVENTS = new Set(["session.command", "session.created"]);

// ADR-182 D-B8 (C29): a steer is text arriving INSIDE a running turn, so its
// acceptance closes the open assistant rows for every run kind — what the agent
// says next is a reply to the steered message — but it is not a new turn, so
// the usage row keeps accumulating.
function isSteerCommand(event: ExecutionEvent): boolean {
  return (
    event.eventType === "session.command" &&
    event.payload?.kind === "session.steer"
  );
}

function unstorableSqlState(error: unknown): string | null {
  for (let cause = error, depth = 0; cause && depth < 5; depth += 1) {
    const code = (cause as { code?: unknown }).code;

    if (typeof code === "string" && UNSTORABLE_SQLSTATES.has(code)) return code;
    cause = (cause as { cause?: unknown }).cause;
  }

  return null;
}

/** Applies one event using fixed-size pointers and indexed message keys.
 * Existing large message bodies stay inside PostgreSQL during concatenation. */
export async function projectTranscriptEvent(
  tx: Db,
  event: ExecutionEvent,
): Promise<boolean> {
  if (isPrunedContextEvent(event)) return false;
  if (
    event.eventType !== "session.update" &&
    !RESET_EVENTS.has(event.eventType) &&
    !SCRATCH_BOUNDARY_EVENTS.has(event.eventType)
  )
    return false;
  const [run] = await tx
    .select({ kind: runs.runKind })
    .from(runs)
    .where(eq(runs.id, event.runId))
    .limit(1);

  if (!run)
    throw new ExecutionEventProjectionError("transcript run is missing", true);
  // ADR-185 / ADR-167 amendment: a librarian's transcript is its conversation
  // (`librarian_messages`); its live tokens ride the run stream's canonical
  // events. A second copy in `run_messages` would outlive a history clear.
  if (run.kind === "librarian") return false;
  if (
    (event.eventType === "session.exited" ||
      event.eventType === "session.crashed") &&
    event.hostSessionId &&
    event.runSequence !== null
  )
    await interruptTranscriptCompactions(tx, event, event.runSequence);
  const scratchBoundary =
    run.kind === "scratch" &&
    SCRATCH_BOUNDARY_EVENTS.has(event.eventType) &&
    !isSteerCommand(event);
  const steerBoundary =
    isSteerCommand(event) && event.payload?.phase === "accepted";

  if (
    event.eventType !== "session.update" &&
    !RESET_EVENTS.has(event.eventType) &&
    !scratchBoundary &&
    !steerBoundary
  )
    return false;
  const nodeAttemptId =
    typeof event.payload?.nodeAttemptId === "string"
      ? event.payload.nodeAttemptId
      : null;

  if (nodeAttemptId) {
    const [attempt] = await tx
      .select({ id: nodeAttempts.id })
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.id, nodeAttemptId),
          eq(nodeAttempts.runId, event.runId),
        ),
      )
      .limit(1);

    if (!attempt)
      throw new ExecutionEventProjectionError(
        "transcript node attempt belongs to another run",
        true,
      );
  }
  // TRC-10: the SAME lock `appendRunMessage` takes. `run_messages` now has a
  // second writer on this scope, and an unlocked read of `next_sequence` by
  // either side is a unique violation waiting for the two to interleave.
  const id = transcriptStateId(event.runId, nodeAttemptId);
  const state = await lockTranscriptState(tx, event.runId, nodeAttemptId);

  if (RESET_EVENTS.has(event.eventType) || scratchBoundary || steerBoundary) {
    await tx
      .update(runTranscriptStates)
      .set({
        openTextSequence: null,
        openThoughtSequence: null,
        ...(scratchBoundary ? { usageSequence: null } : {}),
      })
      .where(eq(runTranscriptStates.id, id));

    return false;
  }
  const context =
    event.payload?.contextReplay === true ? null : readAcpContextUpdate(event);
  const update =
    context?.kind === "compaction" || context?.kind === "summary_chunk"
      ? context
      : interpretSessionUpdate(event.payload?.update);

  if (!update) return false;
  if (event.runSequence === null)
    throw new ExecutionEventProjectionError(
      "transcript event has no sequence",
      true,
    );
  const scope = and(
    eq(runMessages.runId, event.runId),
    nodeAttemptId === null
      ? isNull(runMessages.nodeAttemptId)
      : eq(runMessages.nodeAttemptId, nodeAttemptId),
  );
  const eventId = event.runSequence.toString();
  let nextSequence = state.nextSequence;
  let openTextSequence = state.openTextSequence;
  let openThoughtSequence = state.openThoughtSequence;
  let usageSequence = state.usageSequence;
  const insert = async (
    role: "assistant" | "system" | "tool",
    content: string,
    projectionToolKey: string | null = null,
  ): Promise<number> => {
    const sequence = nextSequence++;

    await tx
      .insert(runMessages)
      .values({
        id: randomUUID(),
        runId: event.runId,
        nodeAttemptId,
        sequence,
        role,
        content,
        firstSupervisorEventId: eventId,
        supervisorEventId: eventId,
        projectionToolKey,
      })
      .onConflictDoUpdate({
        target: [
          runMessages.runId,
          runMessages.nodeAttemptId,
          runMessages.sequence,
        ],
        set: {
          role,
          content,
          firstSupervisorEventId: sql`coalesce(${runMessages.firstSupervisorEventId},${runMessages.supervisorEventId},${eventId})`,
          supervisorEventId: eventId,
          projectionToolKey,
        },
      });

    return sequence;
  };
  const replace = async (
    sequence: number,
    content: string | SQL,
  ): Promise<void> => {
    const rows = await tx
      .update(runMessages)
      .set({
        content,
        firstSupervisorEventId: sql`coalesce(${runMessages.firstSupervisorEventId},${runMessages.supervisorEventId},${eventId})`,
        supervisorEventId: eventId,
      })
      .where(and(scope, eq(runMessages.sequence, sequence)))
      .returning({ id: runMessages.id });

    if (rows.length !== 1)
      throw new ExecutionEventProjectionError(
        "transcript state references a missing message",
        true,
      );
  };

  switch (update.kind) {
    case "compaction":
    case "summary_chunk": {
      const applied = await applyCompactionUpdate({
        tx,
        runId: event.runId,
        nodeAttemptId,
        event,
        update,
        onInsert: async (content, key) => {
          openTextSequence = null;
          openThoughtSequence = null;
          await insert("system", content, key);
        },
      });

      if (!applied) return false;
      break;
    }
    case "text":
      openThoughtSequence = null;
      if (openTextSequence === null)
        openTextSequence = await insert("assistant", update.text);
      else
        await replace(
          openTextSequence,
          sql`${runMessages.content} || ${update.text}`,
        );
      break;
    case "thought":
      openTextSequence = null;
      if (openThoughtSequence === null)
        openThoughtSequence = await insert(
          "system",
          encodeThoughtPayload(update.text),
        );
      else
        await replace(
          openThoughtSequence,
          sql`jsonb_build_object('v', 1, 'kind', 'thought', 'text', (${runMessages.content}::jsonb->>'text') || ${update.text})::text`,
        );
      break;
    case "usage":
      if (usageSequence === null)
        usageSequence = await insert(
          "system",
          encodeUsagePayload(update.used, update.size),
        );
      else
        await replace(
          usageSequence,
          encodeUsagePayload(update.used, update.size),
        );
      break;
    case "tool_call": {
      openTextSequence = null;
      openThoughtSequence = null;
      const key = createHash("sha256").update(update.toolCallId).digest("hex");

      await insert("tool", encodeToolPayload(update), key);
      break;
    }
    case "tool_update": {
      const key = createHash("sha256").update(update.toolCallId).digest("hex");
      const [existing] = await tx
        .select({ sequence: runMessages.sequence })
        .from(runMessages)
        .where(and(scope, eq(runMessages.projectionToolKey, key)))
        .orderBy(desc(runMessages.sequence))
        .limit(1);

      if (!existing) {
        await insert(
          "tool",
          encodeToolPayload({
            name: update.name ?? "tool",
            toolKind: update.toolKind ?? "other",
            status: update.status ?? "pending",
            arg: update.arg ?? "",
            rawInput: update.rawInput ?? null,
            result: update.result ?? "",
          }),
          key,
        );
        break;
      }
      const patch = {
        ...(update.name ? { name: update.name } : {}),
        ...(update.toolKind ? { toolKind: update.toolKind } : {}),
        ...(update.status ? { status: update.status } : {}),
        ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
      };
      const original = sql`${runMessages.content}::jsonb`;
      const result = update.result ?? "";
      const arg = update.arg ?? "";

      await replace(
        existing.sequence,
        sql`(${original} || ${JSON.stringify(patch)}::jsonb || jsonb_build_object(
        'arg', CASE WHEN COALESCE(${original}->>'arg', '') = '' THEN ${arg} ELSE ${original}->>'arg' END,
        'result', CASE WHEN ${result} = '' THEN ${original}->>'result' WHEN COALESCE(${original}->>'result', '') = '' THEN ${result} ELSE (${original}->>'result') || E'\n' || ${result} END
      ))::text`,
      );
      break;
    }
  }
  await tx
    .update(runTranscriptStates)
    .set({ nextSequence, openTextSequence, openThoughtSequence, usageSequence })
    .where(eq(runTranscriptStates.id, id));

  return true;
}

type InterpretedSessionUpdate = NonNullable<
  ReturnType<typeof interpretSessionUpdate>
>;
type ToolCallUpdate = Extract<InterpretedSessionUpdate, { kind: "tool_call" }>;
type ToolUpdatePatch = Extract<
  InterpretedSessionUpdate,
  { kind: "tool_update" }
>;

type PlannedTranscriptOp =
  | { kind: "interrupt_compactions"; event: ExecutionEvent; sequence: bigint }
  | { kind: "reset"; nodeAttemptId: string | null; clearUsage: boolean }
  | {
      kind: "compaction";
      nodeAttemptId: string | null;
      event: ExecutionEvent;
      update: CompactionContextUpdate;
    }
  | {
      kind: "text";
      nodeAttemptId: string | null;
      text: string;
      firstEventId: string;
      lastEventId: string;
    }
  | {
      kind: "thought";
      nodeAttemptId: string | null;
      text: string;
      firstEventId: string;
      lastEventId: string;
    }
  | {
      kind: "usage";
      nodeAttemptId: string | null;
      used: number;
      size: number;
      firstEventId: string;
      lastEventId: string;
    }
  | {
      kind: "tool_call";
      nodeAttemptId: string | null;
      update: ToolCallUpdate;
      eventId: string;
    }
  | {
      kind: "tool_update";
      nodeAttemptId: string | null;
      toolCallId: string;
      name?: string;
      toolKind?: ToolUpdatePatch["toolKind"];
      status?: ToolUpdatePatch["status"];
      rawInput?: unknown;
      hasRawInput: boolean;
      arg: string;
      result: string;
      firstEventId: string;
      lastEventId: string;
    };

type PlannedTranscriptBatch = {
  ops: PlannedTranscriptOp[];
  coalescedChunks: number;
};

function isTranscriptRelevantEvent(event: ExecutionEvent): boolean {
  if (isPrunedContextEvent(event)) return false;

  return (
    event.eventType === "session.update" ||
    RESET_EVENTS.has(event.eventType) ||
    SCRATCH_BOUNDARY_EVENTS.has(event.eventType)
  );
}

function eventNodeAttemptId(event: ExecutionEvent): string | null {
  return typeof event.payload?.nodeAttemptId === "string"
    ? event.payload.nodeAttemptId
    : null;
}

/** Pure in-memory coalescer for a quantum of canonical transcript events.
 * Preserves exact boundary flushes and first/last event IDs without DB I/O. */
function planTranscriptBatchOps(
  events: readonly ExecutionEvent[],
  runKind: string,
  ownedAttemptIds: ReadonlySet<string>,
  onInvalidEvent: (event: ExecutionEvent) => void,
): PlannedTranscriptBatch {
  const ops: PlannedTranscriptOp[] = [];
  let coalescedChunks = 0;

  for (const event of events) {
    if (!isTranscriptRelevantEvent(event)) continue;

    if (
      (event.eventType === "session.exited" ||
        event.eventType === "session.crashed") &&
      event.hostSessionId &&
      event.runSequence !== null
    ) {
      ops.push({
        kind: "interrupt_compactions",
        event,
        sequence: event.runSequence,
      });
    }

    const scratchBoundary =
      runKind === "scratch" &&
      SCRATCH_BOUNDARY_EVENTS.has(event.eventType) &&
      !isSteerCommand(event);
    const steerBoundary =
      isSteerCommand(event) && event.payload?.phase === "accepted";

    if (
      event.eventType !== "session.update" &&
      !RESET_EVENTS.has(event.eventType) &&
      !scratchBoundary &&
      !steerBoundary
    ) {
      continue;
    }

    const nodeAttemptId = eventNodeAttemptId(event);

    if (nodeAttemptId && !ownedAttemptIds.has(nodeAttemptId)) {
      onInvalidEvent(event);
      throw new ExecutionEventProjectionError(
        "transcript node attempt belongs to another run",
        true,
      );
    }

    if (RESET_EVENTS.has(event.eventType) || scratchBoundary || steerBoundary) {
      const prev = ops.at(-1);

      if (prev?.kind === "reset" && prev.nodeAttemptId === nodeAttemptId) {
        prev.clearUsage = prev.clearUsage || scratchBoundary;
        coalescedChunks += 1;
      } else {
        ops.push({
          kind: "reset",
          nodeAttemptId,
          clearUsage: scratchBoundary,
        });
      }
      continue;
    }

    const context =
      event.payload?.contextReplay === true
        ? null
        : readAcpContextUpdate(event);
    const update =
      context?.kind === "compaction" || context?.kind === "summary_chunk"
        ? context
        : interpretSessionUpdate(event.payload?.update);

    if (!update) continue;
    if (event.runSequence === null) {
      onInvalidEvent(event);
      throw new ExecutionEventProjectionError(
        "transcript event has no sequence",
        true,
      );
    }

    const eventId = event.runSequence.toString();
    const prev = ops.at(-1);

    switch (update.kind) {
      case "compaction":
      case "summary_chunk":
        ops.push({ kind: "compaction", nodeAttemptId, event, update });
        break;
      case "text":
        if (prev?.kind === "text" && prev.nodeAttemptId === nodeAttemptId) {
          prev.text += update.text;
          prev.lastEventId = eventId;
          coalescedChunks += 1;
        } else {
          ops.push({
            kind: "text",
            nodeAttemptId,
            text: update.text,
            firstEventId: eventId,
            lastEventId: eventId,
          });
        }
        break;
      case "thought":
        if (prev?.kind === "thought" && prev.nodeAttemptId === nodeAttemptId) {
          prev.text += update.text;
          prev.lastEventId = eventId;
          coalescedChunks += 1;
        } else {
          ops.push({
            kind: "thought",
            nodeAttemptId,
            text: update.text,
            firstEventId: eventId,
            lastEventId: eventId,
          });
        }
        break;
      case "usage":
        if (prev?.kind === "usage" && prev.nodeAttemptId === nodeAttemptId) {
          prev.used = update.used;
          prev.size = update.size;
          prev.lastEventId = eventId;
          coalescedChunks += 1;
        } else {
          ops.push({
            kind: "usage",
            nodeAttemptId,
            used: update.used,
            size: update.size,
            firstEventId: eventId,
            lastEventId: eventId,
          });
        }
        break;
      case "tool_call":
        ops.push({ kind: "tool_call", nodeAttemptId, update, eventId });
        break;
      case "tool_update":
        if (
          prev?.kind === "tool_update" &&
          prev.nodeAttemptId === nodeAttemptId &&
          prev.toolCallId === update.toolCallId
        ) {
          if (update.name) prev.name = update.name;
          if (update.toolKind) prev.toolKind = update.toolKind;
          if (update.status) prev.status = update.status;
          if (update.rawInput !== undefined) {
            prev.rawInput = update.rawInput;
            prev.hasRawInput = true;
          }
          if (!prev.arg && update.arg) prev.arg = update.arg;
          if (update.result) {
            prev.result = prev.result
              ? `${prev.result}\n${update.result}`
              : update.result;
          }
          prev.lastEventId = eventId;
          coalescedChunks += 1;
        } else {
          ops.push({
            kind: "tool_update",
            nodeAttemptId,
            toolCallId: update.toolCallId,
            name: update.name,
            toolKind: update.toolKind,
            status: update.status,
            rawInput: update.rawInput,
            hasRawInput: update.rawInput !== undefined,
            arg: update.arg ?? "",
            result: update.result ?? "",
            firstEventId: eventId,
            lastEventId: eventId,
          });
        }
        break;
    }
  }

  return { ops, coalescedChunks };
}

type ScopeRuntimeState = {
  id: string;
  nodeAttemptId: string | null;
  nextSequence: number;
  openTextSequence: number | null;
  openThoughtSequence: number | null;
  usageSequence: number | null;
  dirty: boolean;
  toolSequences: Map<string, number>;
};

async function applyPlannedTranscriptOps(
  tx: Db,
  runId: string,
  ops: readonly PlannedTranscriptOp[],
): Promise<number> {
  const scopes = new Map<string, ScopeRuntimeState>();
  let sqlWrites = 0;

  const getScope = async (
    nodeAttemptId: string | null,
  ): Promise<ScopeRuntimeState> => {
    const id = transcriptStateId(runId, nodeAttemptId);
    const cached = scopes.get(id);

    if (cached) return cached;
    const locked = await lockTranscriptState(tx, runId, nodeAttemptId);
    const state: ScopeRuntimeState = {
      id,
      nodeAttemptId,
      nextSequence: locked.nextSequence,
      openTextSequence: locked.openTextSequence,
      openThoughtSequence: locked.openThoughtSequence,
      usageSequence: locked.usageSequence,
      dirty: false,
      toolSequences: new Map(),
    };

    scopes.set(id, state);

    return state;
  };

  const scopePredicate = (nodeAttemptId: string | null) =>
    and(
      eq(runMessages.runId, runId),
      nodeAttemptId === null
        ? isNull(runMessages.nodeAttemptId)
        : eq(runMessages.nodeAttemptId, nodeAttemptId),
    );

  const insertMessage = async (
    scope: ScopeRuntimeState,
    role: "assistant" | "system" | "tool",
    content: string,
    firstEventId: string,
    lastEventId: string,
    projectionToolKey: string | null = null,
  ): Promise<number> => {
    const sequence = scope.nextSequence++;

    scope.dirty = true;
    sqlWrites += 1;
    await tx
      .insert(runMessages)
      .values({
        id: randomUUID(),
        runId,
        nodeAttemptId: scope.nodeAttemptId,
        sequence,
        role,
        content,
        firstSupervisorEventId: firstEventId,
        supervisorEventId: lastEventId,
        projectionToolKey,
      })
      .onConflictDoUpdate({
        target: [
          runMessages.runId,
          runMessages.nodeAttemptId,
          runMessages.sequence,
        ],
        set: {
          role,
          content,
          firstSupervisorEventId: sql`coalesce(${runMessages.firstSupervisorEventId},${runMessages.supervisorEventId},${firstEventId})`,
          supervisorEventId: lastEventId,
          projectionToolKey,
        },
      });

    return sequence;
  };

  const replaceMessage = async (
    scope: ScopeRuntimeState,
    sequence: number,
    content: string | SQL,
    firstEventId: string,
    lastEventId: string,
  ): Promise<void> => {
    sqlWrites += 1;
    const rows = await tx
      .update(runMessages)
      .set({
        content,
        firstSupervisorEventId: sql`coalesce(${runMessages.firstSupervisorEventId},${runMessages.supervisorEventId},${firstEventId})`,
        supervisorEventId: lastEventId,
      })
      .where(
        and(
          scopePredicate(scope.nodeAttemptId),
          eq(runMessages.sequence, sequence),
        ),
      )
      .returning({ id: runMessages.id });

    if (rows.length !== 1)
      throw new ExecutionEventProjectionError(
        "transcript state references a missing message",
        true,
      );
  };

  for (const op of ops) {
    switch (op.kind) {
      case "interrupt_compactions":
        await interruptTranscriptCompactions(tx, op.event, op.sequence);
        break;
      case "reset": {
        const scope = await getScope(op.nodeAttemptId);

        scope.openTextSequence = null;
        scope.openThoughtSequence = null;
        if (op.clearUsage) scope.usageSequence = null;
        scope.dirty = true;
        break;
      }
      case "compaction": {
        const scope = await getScope(op.nodeAttemptId);
        const eventId = op.event.runSequence!.toString();

        await applyCompactionUpdate({
          tx,
          runId,
          nodeAttemptId: op.nodeAttemptId,
          event: op.event,
          update: op.update,
          onExistingUpdate: () => {
            sqlWrites += 1;
          },
          onInsert: async (content, key) => {
            scope.openTextSequence = null;
            scope.openThoughtSequence = null;
            await insertMessage(
              scope,
              "system",
              content,
              eventId,
              eventId,
              key,
            );
          },
        });
        break;
      }
      case "text": {
        const scope = await getScope(op.nodeAttemptId);

        scope.openThoughtSequence = null;
        if (scope.openTextSequence === null) {
          scope.openTextSequence = await insertMessage(
            scope,
            "assistant",
            op.text,
            op.firstEventId,
            op.lastEventId,
          );
        } else {
          await replaceMessage(
            scope,
            scope.openTextSequence,
            sql`${runMessages.content} || ${op.text}`,
            op.firstEventId,
            op.lastEventId,
          );
        }
        scope.dirty = true;
        break;
      }
      case "thought": {
        const scope = await getScope(op.nodeAttemptId);

        scope.openTextSequence = null;
        if (scope.openThoughtSequence === null) {
          scope.openThoughtSequence = await insertMessage(
            scope,
            "system",
            encodeThoughtPayload(op.text),
            op.firstEventId,
            op.lastEventId,
          );
        } else {
          await replaceMessage(
            scope,
            scope.openThoughtSequence,
            sql`jsonb_build_object('v', 1, 'kind', 'thought', 'text', (${runMessages.content}::jsonb->>'text') || ${op.text})::text`,
            op.firstEventId,
            op.lastEventId,
          );
        }
        scope.dirty = true;
        break;
      }
      case "usage": {
        const scope = await getScope(op.nodeAttemptId);

        if (scope.usageSequence === null) {
          scope.usageSequence = await insertMessage(
            scope,
            "system",
            encodeUsagePayload(op.used, op.size),
            op.firstEventId,
            op.lastEventId,
          );
        } else {
          await replaceMessage(
            scope,
            scope.usageSequence,
            encodeUsagePayload(op.used, op.size),
            op.firstEventId,
            op.lastEventId,
          );
        }
        scope.dirty = true;
        break;
      }
      case "tool_call": {
        const scope = await getScope(op.nodeAttemptId);

        scope.openTextSequence = null;
        scope.openThoughtSequence = null;
        const key = createHash("sha256")
          .update(op.update.toolCallId)
          .digest("hex");
        const sequence = await insertMessage(
          scope,
          "tool",
          encodeToolPayload(op.update),
          op.eventId,
          op.eventId,
          key,
        );

        scope.toolSequences.set(key, sequence);
        scope.dirty = true;
        break;
      }
      case "tool_update": {
        const scope = await getScope(op.nodeAttemptId);
        const key = createHash("sha256").update(op.toolCallId).digest("hex");
        let existingSequence = scope.toolSequences.get(key);

        if (existingSequence === undefined) {
          const [existing] = await tx
            .select({ sequence: runMessages.sequence })
            .from(runMessages)
            .where(
              and(
                scopePredicate(scope.nodeAttemptId),
                eq(runMessages.projectionToolKey, key),
              ),
            )
            .orderBy(desc(runMessages.sequence))
            .limit(1);

          existingSequence = existing?.sequence;
          if (existingSequence !== undefined) {
            scope.toolSequences.set(key, existingSequence);
          }
        }

        if (existingSequence === undefined) {
          const insertedSequence = await insertMessage(
            scope,
            "tool",
            encodeToolPayload({
              name: op.name ?? "tool",
              toolKind: op.toolKind ?? "other",
              status: op.status ?? "pending",
              arg: op.arg,
              rawInput: op.hasRawInput ? (op.rawInput ?? null) : null,
              result: op.result,
            }),
            op.firstEventId,
            op.lastEventId,
            key,
          );

          scope.toolSequences.set(key, insertedSequence);
          break;
        }

        const patch = {
          ...(op.name ? { name: op.name } : {}),
          ...(op.toolKind ? { toolKind: op.toolKind } : {}),
          ...(op.status ? { status: op.status } : {}),
          ...(op.hasRawInput ? { rawInput: op.rawInput } : {}),
        };
        const original = sql`${runMessages.content}::jsonb`;

        await replaceMessage(
          scope,
          existingSequence,
          sql`(${original} || ${JSON.stringify(patch)}::jsonb || jsonb_build_object(
            'arg', CASE WHEN COALESCE(${original}->>'arg', '') = '' THEN ${op.arg} ELSE ${original}->>'arg' END,
            'result', CASE WHEN ${op.result} = '' THEN ${original}->>'result' WHEN COALESCE(${original}->>'result', '') = '' THEN ${op.result} ELSE (${original}->>'result') || E'\n' || ${op.result} END
          ))::text`,
          op.firstEventId,
          op.lastEventId,
        );
        break;
      }
    }
  }

  for (const scope of scopes.values()) {
    if (!scope.dirty) continue;
    sqlWrites += 1;
    await tx
      .update(runTranscriptStates)
      .set({
        nextSequence: scope.nextSequence,
        openTextSequence: scope.openTextSequence,
        openThoughtSequence: scope.openThoughtSequence,
        usageSequence: scope.usageSequence,
      })
      .where(eq(runTranscriptStates.id, scope.id));
  }

  return sqlWrites;
}

async function projectTranscriptBatch(
  tx: Db,
  events: readonly ExecutionEvent[],
  onProgress: (event: ExecutionEvent) => void,
  softDeadline: number,
): Promise<number> {
  if (events.length === 0) return 0;

  const firstRelevant = events.find(isTranscriptRelevantEvent);

  if (!firstRelevant) {
    onProgress(events[events.length - 1]!);

    return events.length;
  }

  const runId = firstRelevant.runId;
  const [run] = await tx
    .select({ kind: runs.runKind })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  if (!run) {
    onProgress(firstRelevant);
    throw new ExecutionEventProjectionError("transcript run is missing", true);
  }
  if (run.kind === "librarian") {
    onProgress(events[events.length - 1]!);

    return events.length;
  }

  const attemptIds = new Set<string>();

  for (const event of events) {
    if (!isTranscriptRelevantEvent(event)) continue;
    const scratchBoundary =
      run.kind === "scratch" &&
      SCRATCH_BOUNDARY_EVENTS.has(event.eventType) &&
      !isSteerCommand(event);
    const steerBoundary =
      isSteerCommand(event) && event.payload?.phase === "accepted";

    if (
      event.eventType !== "session.update" &&
      !RESET_EVENTS.has(event.eventType) &&
      !scratchBoundary &&
      !steerBoundary
    ) {
      continue;
    }
    const attemptId = eventNodeAttemptId(event);

    if (attemptId) attemptIds.add(attemptId);
  }

  const ownedAttemptIds = new Set<string>();

  if (attemptIds.size > 0) {
    const ownedRows = await tx
      .select({ id: nodeAttempts.id })
      .from(nodeAttempts)
      .where(
        and(
          eq(nodeAttempts.runId, runId),
          inArray(nodeAttempts.id, [...attemptIds]),
        ),
      );

    for (const row of ownedRows) ownedAttemptIds.add(row.id);
  }

  const plan = planTranscriptBatchOps(
    events,
    run.kind,
    ownedAttemptIds,
    onProgress,
  );

  if (plan.ops.length === 0) {
    onProgress(events[events.length - 1]!);

    return events.length;
  }

  try {
    const sqlWrites = await tx.transaction((sp) =>
      applyPlannedTranscriptOps(sp, runId, plan.ops),
    );

    onProgress(events[events.length - 1]!);
    logger.debug(
      {
        runId,
        eventsCount: events.length,
        sqlWrites,
        coalescedChunks: plan.coalescedChunks,
      },
      "transcript-projection-batch-coalesced",
    );

    return events.length;
  } catch (error) {
    if (isNonReplayableBatchError(error)) {
      logger.debug(
        { runId, pgCode: pgErrorOf(error)?.code ?? null },
        "transcript-projection-batch-rethrow-non-replayable",
      );
      throw error;
    }

    // Savepoint rolled back cleanly. Replay sequentially to isolate and
    // attribute the exact failing or poisonous event in order.
    let projected = 0;

    for (const event of events) {
      if (projected > 0 && performance.now() >= softDeadline) break;
      onProgress(event);
      await projectSingleWithUnstorableMapping(tx, event);
      projected += 1;
    }

    return projected;
  }
}
