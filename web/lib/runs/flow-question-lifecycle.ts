import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import pino from "pino";

import { systemCloseActiveAssignmentsForHitlRequest } from "@/lib/assignments/service";
import { acceptedFlowNodeSuccessorExists } from "@/lib/db/flow-node-answer-delivery";
import { hitlRequests } from "@/lib/db/schema";
import { notifyNodeQuestionChanged } from "@/lib/runs/peek-wake";

const log = pino({
  name: "flow-question-lifecycle",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Close the Run's questions in its lifecycle transaction. Preserve any accepted answer as evidence. */
export async function closeFlowNodeQuestions(
  tx: Db,
  runId: string,
  reason: string,
): Promise<void> {
  const closed = await tx
    .update(hitlRequests)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(hitlRequests.runId, runId),
        isNotNull(hitlRequests.flowNodeAttemptId),
        isNull(hitlRequests.respondedAt),
        isNull(hitlRequests.supersededAt),
        or(
          isNull(hitlRequests.flowAnswerAcceptedAt),
          not(acceptedFlowNodeSuccessorExists(hitlRequests)),
        ),
      ),
    )
    .returning({ id: hitlRequests.id });

  if (closed.length === 0) return;
  for (const question of closed) {
    await systemCloseActiveAssignmentsForHitlRequest({
      db: tx,
      hitlRequestId: question.id,
      reason,
    });
  }
  await notifyNodeQuestionChanged(tx, runId);
  log.info(
    { runId, reason, count: closed.length },
    "Flow node questions closed",
  );
}

/** Repair rows left by a terminal writer without touching task-scoped agent questions. */
export async function reconcileClosedFlowNodeQuestions(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    const question = alias(hitlRequests, "q");
    const candidates = await tx.execute<{ id: string }>(sql`
      SELECT r.id FROM runs r WHERE r.run_kind='flow'
        AND r.status IN ('Review','Done','Failed','Abandoned','Crashed')
        AND EXISTS (SELECT 1 FROM hitl_requests q WHERE q.run_id=r.id
          AND q.flow_node_attempt_id IS NOT NULL AND q.responded_at IS NULL AND q.superseded_at IS NULL
          AND (q.flow_answer_accepted_at IS NULL OR NOT ${acceptedFlowNodeSuccessorExists(question)}))
      ORDER BY r.ended_at NULLS LAST,r.id LIMIT 30 FOR NO KEY UPDATE OF r SKIP LOCKED
    `);

    for (const row of candidates.rows)
      await closeFlowNodeQuestions(tx, row.id, "closed run reconciliation");
  });
}
