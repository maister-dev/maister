import "server-only";

import type { Db } from "@/lib/evaluations/db";

import { and, asc, eq, gt, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { evaluationEvents, evaluationStudies } from "@/lib/db/schema";

export interface AppendEventArgs {
  studyId: string;
  executionId?: string | null;
  eventType: string;
  // Bounded ids/status/counts only — NEVER evidence or rationale bodies (D17).
  payload?: Record<string, unknown>;
}

// Append one replayable Study event with a per-Study monotonic sequence.
// Serializes sequence allocation by locking the parent Study row FOR UPDATE, so
// two concurrent executions in the same Study can never collide on
// UNIQUE(study_id, sequence). MUST run inside the caller's transaction.
export async function appendEvaluationEvent(
  tx: Db,
  args: AppendEventArgs,
): Promise<{ sequence: number; id: string }> {
  await tx
    .select({ id: evaluationStudies.id })
    .from(evaluationStudies)
    .where(eq(evaluationStudies.id, args.studyId))
    .for("update");

  const [{ next }] = await tx
    .select({
      next: sql<number>`coalesce(max(${evaluationEvents.sequence}), 0) + 1`,
    })
    .from(evaluationEvents)
    .where(eq(evaluationEvents.studyId, args.studyId));

  const [row] = await tx
    .insert(evaluationEvents)
    .values({
      studyId: args.studyId,
      executionId: args.executionId ?? null,
      sequence: next,
      eventType: args.eventType,
      payload: args.payload ?? null,
    })
    .returning({ id: evaluationEvents.id });

  return { sequence: next, id: row.id };
}

export interface EvaluationEventRow {
  id: string;
  studyId: string;
  executionId: string | null;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

// Read the replay tail for a Study after a client's Last-Event-ID (the
// sequence). `afterSequence = 0` returns the full history in order.
export async function readEvaluationEvents(
  args: { studyId: string; afterSequence?: number; limit?: number },
  db?: Db,
): Promise<EvaluationEventRow[]> {
  const d = db ?? getDb();
  const after = args.afterSequence ?? 0;
  const rows = await d
    .select()
    .from(evaluationEvents)
    .where(
      and(
        eq(evaluationEvents.studyId, args.studyId),
        gt(evaluationEvents.sequence, after),
      ),
    )
    .orderBy(asc(evaluationEvents.sequence))
    .limit(Math.min(args.limit ?? 500, 1000));

  return rows.map((r) => ({
    id: r.id,
    studyId: r.studyId,
    executionId: r.executionId ?? null,
    sequence: r.sequence,
    eventType: r.eventType,
    payload: r.payload ?? null,
    createdAt:
      r.createdAt instanceof Date
        ? r.createdAt.toISOString()
        : String(r.createdAt),
  }));
}

// One SSE frame. `id:` is the per-Study sequence so a browser reconnect sends
// `Last-Event-ID` and the route replays from there (D17 — replay source is the
// DB log, never in-memory state).
export function formatSseFrame(event: EvaluationEventRow): string {
  const data = JSON.stringify({
    executionId: event.executionId,
    sequence: event.sequence,
    payload: event.payload,
  });

  return `id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${data}\n\n`;
}
