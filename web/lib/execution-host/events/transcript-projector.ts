import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionEventProjector } from "./projector";
import type { SQL } from "drizzle-orm";
import type { CompactionMarker } from "@/lib/run-transcript/compaction";

import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import {
  acpContextUpdateType,
  clipCompactionText,
  MAX_COMPACTION_SUMMARY_LENGTH,
} from "../../../../runtime/acp-context";

import { CANONICAL_PROJECTION_CONSUMERS } from "./projection-consumers";
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

const RESET_EVENTS = new Set([
  "session.permission_request",
  "session.hook_trip",
  "session.exited",
  "session.crashed",
]);

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
  project: async (tx, event) => {
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
  },
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
          and(
            eq(runMessages.runId, event.runId),
            eq(runMessages.projectionToolKey, key),
          ),
        )
        .limit(1);

      if (
        existing?.lastEventId &&
        BigInt(existing.lastEventId) >= event.runSequence
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
              summary: clipCompactionText(
                summary,
                MAX_COMPACTION_SUMMARY_LENGTH,
              ),
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
        await tx
          .update(runMessages)
          .set({
            content,
            supervisorEventId: eventId,
          })
          .where(eq(runMessages.id, existing.id));
      } else {
        openTextSequence = null;
        openThoughtSequence = null;
        await insert("system", content, key);
      }
      await advanceCompactionTranscriptRevision(
        tx,
        event.runId,
        existing ? existing.nodeAttemptId : nodeAttemptId,
        event.runSequence,
      );
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
