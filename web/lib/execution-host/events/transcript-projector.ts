import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { ExecutionEventProjector } from "./projector";
import type { SQL } from "drizzle-orm";

import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { CANONICAL_PROJECTION_CONSUMERS } from "./projection-consumers";
import { ExecutionEventProjectionError } from "./projector";

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
  project: async (tx, event) => {
    await projectTranscriptEvent(tx, event);
  },
};

/** Applies one event using fixed-size pointers and indexed message keys.
 * Existing large message bodies stay inside PostgreSQL during concatenation. */
export async function projectTranscriptEvent(
  tx: Db,
  event: ExecutionEvent,
): Promise<boolean> {
  if (
    event.eventType !== "session.update" &&
    !RESET_EVENTS.has(event.eventType)
  )
    return false;
  const [run] = await tx
    .select({ kind: runs.runKind })
    .from(runs)
    .where(eq(runs.id, event.runId))
    .limit(1);

  if (!run)
    throw new ExecutionEventProjectionError("transcript run is missing", true);
  // Scratch owns interleaved user/assistant positions and its own projector.
  if (run.kind === "scratch") return false;
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
  const id = createHash("sha256")
    .update(JSON.stringify([event.runId, nodeAttemptId]))
    .digest("hex");

  await tx
    .insert(runTranscriptStates)
    .values({ id, runId: event.runId, nodeAttemptId })
    .onConflictDoNothing();
  const [state] = await tx
    .select()
    .from(runTranscriptStates)
    .where(eq(runTranscriptStates.id, id))
    .limit(1);

  if (!state)
    throw new ExecutionEventProjectionError(
      "transcript state is missing",
      true,
    );
  if (RESET_EVENTS.has(event.eventType)) {
    await tx
      .update(runTranscriptStates)
      .set({ openTextSequence: null, openThoughtSequence: null })
      .where(eq(runTranscriptStates.id, id));

    return false;
  }
  const update = interpretSessionUpdate(event.payload?.update);

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
        supervisorEventId: eventId,
        projectionToolKey,
      })
      .onConflictDoUpdate({
        target: [
          runMessages.runId,
          runMessages.nodeAttemptId,
          runMessages.sequence,
        ],
        set: { role, content, supervisorEventId: eventId, projectionToolKey },
      });

    return sequence;
  };
  const replace = async (
    sequence: number,
    content: string | SQL,
  ): Promise<void> => {
    const rows = await tx
      .update(runMessages)
      .set({ content, supervisorEventId: eventId })
      .where(and(scope, eq(runMessages.sequence, sequence)))
      .returning({ id: runMessages.id });

    if (rows.length !== 1)
      throw new ExecutionEventProjectionError(
        "transcript state references a missing message",
        true,
      );
  };

  switch (update.kind) {
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
