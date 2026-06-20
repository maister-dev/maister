import "server-only";

import { and, inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import {
  CASCADE_NON_TERMINAL_RUN_STATUSES,
  getRunSubtreeIds,
  getUnlaunchedAutoChildTaskIds,
} from "@/lib/queries/run";
import { gcAgeDays } from "@/lib/instance-config";
import { poolForRunKind, promoteNextPending } from "@/lib/scheduler";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, tasks, workspaces } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "orchestrator-cascade",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CascadeReason = "user_stopped" | "orchestrator-stuck";

export interface CascadeAbandonOptions {
  db?: Db;
}

export interface CascadeAbandonResult {
  cascadedRunCount: number;
  abandonedTaskCount: number;
}

type CascadedRunRow = {
  id: string;
  projectId: string;
  taskId: string | null;
  flowId: string | null;
  runKind: string;
  parentRunId: string | null;
};

// M36 Phase 7 (T7.4, ADR-095): abandon the orchestrator's whole run sub-tree in
// ONE transaction. The status-filtered bulk UPDATE both cancels in-flight
// children AND releases WaitingOnChildren descendants without per-kind dispatch;
// an un-launched as-plan child task is also marked Abandoned so the auto-launcher
// never fires it into a cancelled tree. Idempotent: a re-run finds every
// descendant already terminal → the filtered UPDATE matches nothing → no events.
//
// The orchestrator run ITSELF is NOT touched here — the caller flips it terminal
// (children-first ordering) right after. `promoteNextPending` runs AFTER the tx,
// once per pool that actually had a cascaded terminal, so freed flow/agent slots
// are reclaimed.
export async function cascadeAbandonRunTree(
  orchestratorRunId: string,
  orchestratorTaskId: string | null,
  reason: CascadeReason,
  opts: CascadeAbandonOptions = {},
): Promise<CascadeAbandonResult> {
  const database = opts.db ?? getDb();

  const subtreeIds = await getRunSubtreeIds(orchestratorRunId, database);
  const unlaunchedTaskIds = orchestratorTaskId
    ? await getUnlaunchedAutoChildTaskIds(orchestratorTaskId, database)
    : [];

  if (subtreeIds.length === 0 && unlaunchedTaskIds.length === 0) {
    log.debug(
      { orchestratorRunId, reason },
      "cascadeAbandonRunTree: nothing to cascade",
    );

    return { cascadedRunCount: 0, abandonedTaskCount: 0 };
  }

  const cascaded: CascadedRunRow[] = await database.transaction(
    async (tx: Db) => {
      const endedAt = new Date();

      const runRows: CascadedRunRow[] =
        subtreeIds.length > 0
          ? await tx
              .update(runs)
              .set({ status: "Abandoned", endedAt })
              .where(
                and(
                  inArray(runs.id, subtreeIds),
                  inArray(runs.status, [...CASCADE_NON_TERMINAL_RUN_STATUSES]),
                ),
              )
              .returning({
                id: runs.id,
                projectId: runs.projectId,
                taskId: runs.taskId,
                flowId: runs.flowId,
                runKind: runs.runKind,
                parentRunId: runs.parentRunId,
              })
          : [];

      if (unlaunchedTaskIds.length > 0) {
        await tx
          .update(tasks)
          .set({ status: "Abandoned", updatedAt: endedAt })
          .where(inArray(tasks.id, unlaunchedTaskIds));
      }

      if (runRows.length > 0) {
        // Same GC deadline pattern as markAbandoned — every cascaded run shares
        // the one endedAt instant. The batch UPDATE no-ops where a descendant
        // has no workspace row (agent runs with workspace none/repo_read).
        const scheduledRemovalAt = new Date(
          endedAt.getTime() + gcAgeDays() * 86_400_000,
        );

        await tx
          .update(workspaces)
          .set({ scheduledRemovalAt })
          .where(
            inArray(
              workspaces.runId,
              runRows.map((row) => row.id),
            ),
          );

        for (const row of runRows) {
          await emitDomainEvent({
            db: tx,
            kind: "run.abandoned",
            projectId: row.projectId,
            runId: row.id,
            taskId: row.taskId,
            actor: { type: "system", id: null },
            parentRunId: row.parentRunId,
            payload: {
              runId: row.id,
              taskId: row.taskId,
              flowId: row.flowId,
              runKind: row.runKind,
              reason: `cascade/${reason}`,
            },
          });
        }
      }

      return runRows;
    },
  );

  // Reclaim freed slots per pool the cascade actually emptied (a sub-tree mixes
  // flow + agent run_kinds, each on its own budget).
  const pools = new Set(cascaded.map((row) => poolForRunKind(row.runKind)));

  for (const pool of pools) {
    await promoteNextPending({ db: database, pool });
  }

  log.info(
    {
      orchestratorRunId,
      reason,
      cascadedRunCount: cascaded.length,
      abandonedTaskCount: unlaunchedTaskIds.length,
      pools: [...pools],
    },
    "cascadeAbandonRunTree: sub-tree abandoned",
  );

  return {
    cascadedRunCount: cascaded.length,
    abandonedTaskCount: unlaunchedTaskIds.length,
  };
}
