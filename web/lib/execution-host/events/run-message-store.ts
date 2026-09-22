import "server-only";

import type { Db } from "../db";

import { createHash, randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";
import pino from "pino";

import { ExecutionEventProjectionError } from "./projector";

import { runMessages, runTranscriptStates } from "@/lib/db/schema";

const log = pino({
  name: "run-message-store",
  level: process.env.LOG_LEVEL ?? "info",
});

export type TranscriptScopeState = {
  id: string;
  nextSequence: number;
  openTextSequence: number | null;
  openThoughtSequence: number | null;
  usageSequence: number | null;
};

/** The `(runId, nodeAttemptId)` scope's stable row id. Shared so the two
 * writers cannot drift onto two different rows and think they hold one lock. */
export function transcriptStateId(
  runId: string,
  nodeAttemptId: string | null,
): string {
  return createHash("sha256")
    .update(JSON.stringify([runId, nodeAttemptId]))
    .digest("hex");
}

/**
 * Take the scope's allocator row `FOR UPDATE`, initializing it after retained
 * messages (or at sequence 0 for an empty scope).
 *
 * TRC-10. `run_messages` is uniquely keyed `(run_id, node_attempt_id,
 * sequence)`, and until prompts were recorded the transcript projector was the
 * only allocator — so "read `next_sequence`, insert, bump" was safe purely by
 * being alone. With a second writer on the same scope, two readers of the same
 * `next_sequence` produce a hard unique violation on the paid dispatch path.
 * Both writers take THIS lock; contention is one row per scope.
 */
export async function lockTranscriptState(
  tx: Db,
  runId: string,
  nodeAttemptId: string | null,
): Promise<TranscriptScopeState> {
  const id = transcriptStateId(runId, nodeAttemptId);

  await tx
    .insert(runTranscriptStates)
    .values({
      id,
      runId,
      nodeAttemptId,
      nextSequence: sql`(SELECT COALESCE(MAX(sequence) + 1, 0) FROM run_messages WHERE run_id = ${runId} AND node_attempt_id IS NOT DISTINCT FROM ${nodeAttemptId})`,
    })
    .onConflictDoNothing();

  const [state] = await tx
    .select()
    .from(runTranscriptStates)
    .where(eq(runTranscriptStates.id, id))
    .for("update")
    .limit(1);

  // Preserves the transcript projector's own prior semantics for this case: a
  // PERMANENT projection failure, not a transient one to retry forever.
  if (!state) {
    throw new ExecutionEventProjectionError(
      "transcript state is missing",
      true,
    );
  }

  return state as TranscriptScopeState;
}

export type AppendRunMessageInput = {
  runId: string;
  nodeAttemptId: string | null;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  /** TRC-06: present only on a recorded dispatch. A NULL leaves the row
   * outside the partial unique index entirely, which is what keeps the
   * projector's own untagged inserts unconstrained by it. */
  promptDispatchKey?: string | null;
  supervisorEventId?: string | null;
};

/**
 * Append one message to a run's transcript, allocating its sequence under the
 * scope lock.
 *
 * Knows nothing about prompts: bounding, truncation markers, dispatch-key
 * derivation and the context-mount line all belong to the caller that has a
 * prompt to record. This is the generic allocator both writers share.
 *
 * A row whose `promptDispatchKey` is already present is a NO-OP, not an error
 * (TRC-06 / EDGE-TRC-06): a redelivered dispatch must not double-write, and
 * must not surface as a failure on a best-effort path.
 */
export async function appendRunMessage(
  tx: Db,
  input: AppendRunMessageInput,
): Promise<{ sequence: number; inserted: boolean }> {
  const promptDispatchKey = input.promptDispatchKey ?? null;
  const state = await lockTranscriptState(tx, input.runId, input.nodeAttemptId);
  const sequence = state.nextSequence;
  const inserted = await tx
    .insert(runMessages)
    .values({
      id: randomUUID(),
      runId: input.runId,
      nodeAttemptId: input.nodeAttemptId,
      sequence,
      role: input.role,
      content: input.content,
      supervisorEventId: input.supervisorEventId ?? null,
      promptDispatchKey,
    })
    // The conflict target names the PARTIAL index, predicate included, so an
    // untagged row can never be suppressed by it.
    .onConflictDoNothing({
      target: [
        runMessages.runId,
        runMessages.nodeAttemptId,
        runMessages.promptDispatchKey,
      ],
      where: sql`${runMessages.promptDispatchKey} IS NOT NULL`,
    })
    .returning({ id: runMessages.id });

  // Reachable only for a keyed row: the conflict target carries the index's
  // own `IS NOT NULL` predicate, so an untagged row cannot be suppressed here.
  // A sequence collision is NOT swallowed — it raises, which is what makes a
  // failure of the scope lock visible instead of silent.
  if (inserted.length === 0 && promptDispatchKey !== null) {
    const [existing] = await tx
      .select({ sequence: runMessages.sequence })
      .from(runMessages)
      .where(
        and(
          eq(runMessages.runId, input.runId),
          input.nodeAttemptId === null
            ? isNull(runMessages.nodeAttemptId)
            : eq(runMessages.nodeAttemptId, input.nodeAttemptId),
          eq(runMessages.promptDispatchKey, promptDispatchKey),
        ),
      )
      .limit(1);

    log.debug(
      {
        runId: input.runId,
        nodeAttemptId: input.nodeAttemptId,
        promptDispatchKey,
        sequence: existing?.sequence ?? null,
      },
      "run message already recorded for this dispatch",
    );

    return { sequence: existing.sequence, inserted: false };
  }

  await tx
    .update(runTranscriptStates)
    .set({ nextSequence: sequence + 1 })
    .where(eq(runTranscriptStates.id, state.id));

  log.debug(
    {
      runId: input.runId,
      nodeAttemptId: input.nodeAttemptId,
      role: input.role,
      sequence,
    },
    "run message appended",
  );

  return { sequence, inserted: true };
}
