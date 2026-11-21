import "server-only";

import type { WaitTx } from "@/lib/waits/store";

import { and, eq, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { nodeAttempts, runWaitDeliveries, runWaits } from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";

export function queuedConditionResumeExists(
  runId: SQLWrapper | string,
): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${runWaits} WHERE ${runWaits.runId} = ${runId}
      AND ${runWaits.resumeState} = 'queued'
  )`;
}

/** The caller owns the run lock and is committing its stop or abandonment. */
export async function closeConditionWaitsForRun(
  tx: WaitTx,
  runId: string,
  reason: "run_stopped" | "run_abandoned" | "wait_park_timeout",
): Promise<void> {
  const closed = await tx
    .update(runWaits)
    .set({
      state: "closed",
      closedAt: sql`clock_timestamp()`,
      version: sql`${runWaits.version} + 1`,
    })
    .where(
      and(
        eq(runWaits.runId, runId),
        inArray(runWaits.state, ["reserved", "parking", "open"]),
      ),
    )
    .returning({
      id: runWaits.id,
      projectId: runWaits.projectId,
      attemptId: runWaits.nodeAttemptId,
    });
  const invalidated = await tx
    .update(runWaits)
    .set({ resumeState: "invalidated", version: sql`${runWaits.version} + 1` })
    .where(
      and(
        eq(runWaits.runId, runId),
        inArray(runWaits.resumeState, ["queued", "admitted"]),
      ),
    )
    .returning({ id: runWaits.id, projectId: runWaits.projectId });

  if (closed.length) {
    await tx
      .update(nodeAttempts)
      .set({ status: "Stale", endedAt: sql`clock_timestamp()` })
      .where(
        and(
          inArray(
            nodeAttempts.id,
            closed.flatMap((wait) => (wait.attemptId ? [wait.attemptId] : [])),
          ),
          eq(nodeAttempts.status, "Running"),
        ),
      );
    await tx
      .update(runWaitDeliveries)
      .set({ application: "not_applied" })
      .where(
        and(
          inArray(
            runWaitDeliveries.waitId,
            closed.map((wait) => wait.id),
          ),
          eq(runWaitDeliveries.application, "pending"),
        ),
      );
  }

  for (const wait of [...closed, ...invalidated])
    await emitDomainEvent({
      db: tx,
      kind: "run.wait_closed",
      projectId: wait.projectId,
      runId,
      actor: { type: "system", id: null },
      payload: { schemaVersion: 1, waitId: wait.id, reason },
    });
}
