import "server-only";

import type { MergeCompletionDecision } from "@/lib/tasks/completion-evidence";

import { sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import { completeTaskFromConfirmedMerge } from "@/lib/services/task-completion";

// FIXME(any): narrow after the repository converges on one drizzle peer.
type Db = any;

const log = pino({
  name: "reconcile-merged-completion",
  level: process.env.LOG_LEVEL ?? "info",
});

export type MergedCompletionReport = {
  mode: "dry-run" | "apply";
  applied: number;
  tasks: {
    taskKey: string;
    taskId: string;
    runId: string;
    decision: MergeCompletionDecision["kind"];
    reason?: string;
  }[];
};

class DryRunRollback extends Error {
  constructor(readonly decision: MergeCompletionDecision) {
    super("dry-run rollback");
  }
}

/**
 * ADR-207 one-time history pass: InFlight tasks whose newest flow Run is
 * already merged (merged before run.pr_merged existed). Dry-run evaluates the
 * real entry point inside a rolled-back transaction, so the report and the
 * apply can never disagree. Done tasks are never candidates.
 */
export async function reconcileMergedTaskCompletion(
  options: { apply: boolean },
  db: Db = getDb(),
): Promise<MergedCompletionReport> {
  const result = await db.execute(sql`
    SELECT t.id AS task_id, newest.id AS run_id,
           p.task_key || '-' || t.number AS task_key
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN LATERAL (
      SELECT r.id FROM runs r
      WHERE r.task_id = t.id AND r.run_kind = 'flow'
      ORDER BY r.started_at DESC, r.id DESC
      LIMIT 1
    ) newest ON true
    JOIN workspaces w ON w.run_id = newest.id
    WHERE t.status = 'InFlight' AND w.pr_state = 'merged'
    ORDER BY p.task_key, t.number
  `);
  const report: MergedCompletionReport = {
    mode: options.apply ? "apply" : "dry-run",
    applied: 0,
    tasks: [],
  };

  for (const row of result.rows as Array<Record<string, string>>) {
    const evaluate = (tx: Db) =>
      completeTaskFromConfirmedMerge(row.task_id, row.run_id, tx);
    const decision: MergeCompletionDecision = options.apply
      ? await db.transaction(evaluate)
      : await db
          .transaction(async (tx: Db) => {
            throw new DryRunRollback(await evaluate(tx));
          })
          .catch((err: unknown) => {
            if (err instanceof DryRunRollback) return err.decision;
            throw err;
          });

    if (options.apply && decision.kind === "apply") report.applied += 1;
    report.tasks.push({
      taskKey: row.task_key,
      taskId: row.task_id,
      runId: row.run_id,
      decision: decision.kind,
      ...(decision.kind === "apply" ? {} : { reason: decision.reason }),
    });
  }

  log.info(
    {
      mode: report.mode,
      candidates: report.tasks.length,
      applied: report.applied,
    },
    "[taskCompletion.reconcile] summary",
  );

  return report;
}
