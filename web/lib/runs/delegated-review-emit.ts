import "server-only";

import pino from "pino";

import { emitDomainEvent } from "@/lib/domain-events/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "delegated-review-emit",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ReviewFlipRow = {
  runId: string;
  projectId: string;
  taskId: string | null;
  flowId: string | null;
  runKind: string;
  parentRunId: string | null;
};

/**
 * The ONE rule for `run.review` as a DOMAIN event: a run entering `Review`
 * emits it iff it is a delegated child (`parent_run_id` set), inside the same
 * transaction as the status flip.
 *
 * `run.review` is a SETTLED kind `orchestrator_resume` waits on. A parked
 * orchestrator whose child enters `Review` through a path that does not emit
 * never wakes, and reconcile then crashes it as `orchestrator-stuck` and
 * cascade-abandons every child. Every Review flip therefore routes through
 * here — the graph runner, the operator stop, the sync-resolver returns, and
 * the rework-claim release — so a new flip cannot silently miss the rule. A
 * top-level Review has no orchestrator to route to and emits nothing here; the
 * webhook `run.review` is a separate, unconditional surface.
 *
 * Returns whether an event was emitted.
 */
export async function emitDelegatedReviewIfChild(
  tx: Db,
  row: ReviewFlipRow,
): Promise<boolean> {
  if (!row.parentRunId) return false;

  await emitDomainEvent({
    db: tx,
    kind: "run.review",
    projectId: row.projectId,
    taskId: row.taskId,
    runId: row.runId,
    actor: { type: "system", id: null },
    parentRunId: row.parentRunId,
    payload: {
      runId: row.runId,
      taskId: row.taskId,
      flowId: row.flowId,
      runKind: row.runKind,
      status: "Review",
    },
  });
  log.info(
    { runId: row.runId, parentRunId: row.parentRunId },
    "[delegation.wake] run.review emitted for a delegated child",
  );

  return true;
}
