import "server-only";

import type {
  ExecutionHosts,
  SupervisorSessionRecord,
} from "@/lib/execution-host";
import type { Db as ExecutionDb } from "@/lib/execution-host/db";
import type { Run } from "@/lib/db/schema";

import { and, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { abandonUnlaunchedTasks } from "@/lib/services/tasks";
import { teardownLiveSessionsForRuns } from "@/lib/runs/session-teardown";
import { revokeOrchestratorRunTokensForRun } from "@/lib/agents/tokens";
import { supersedeUndispatchedMessageTurns } from "@/lib/agents/turns";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { causeReason } from "@/lib/domain-events/taxonomy";
import {
  createExecutionHosts,
  releaseAssignmentForRun,
} from "@/lib/execution-host";
import { runs as executionRuns } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  CASCADE_NON_TERMINAL_RUN_STATUSES,
  getRunSubtreeIds,
  getUnlaunchedAutoChildTaskIds,
} from "@/lib/queries/run";
import { gcAgeDays } from "@/lib/instance-config";
import { poolForRunKind, promoteNextPending } from "@/lib/scheduler";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, workspaces } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "orchestrator-cascade",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CascadeReason =
  "user_stopped" | "orchestrator-stuck" | "budget_exceeded";

export interface CascadeAbandonOptions {
  db?: Db;
  executionHosts?: ExecutionHosts;
}

async function abandonReceiptBackedChild(
  db: ExecutionDb,
  hosts: ExecutionHosts,
  child: Run,
  reason: CascadeReason,
): Promise<boolean> {
  if (child.executionAssignmentId !== null) {
    const client = await hosts.forAssignment({
      id: child.executionAssignmentId,
    });

    for (const session of await client.sessionsForRun())
      if (session.status === "live")
        await client.deleteSession(session.sessionId);
  }

  if (child.runKind === "flow" && child.parentRunId !== null) {
    const { finalizeCompanyFlowRun } =
      await import("@/lib/run-results/company-flow-terminal");

    return finalizeCompanyFlowRun({
      db,
      rootDb: db,
      hosts,
      runId: child.id,
      requested: "Abandoned",
      cascadeParentRunId: child.parentRunId,
      driverToken: child.flowDriverToken ?? undefined,
      errorCode: null,
      reason: `cascade/${reason}`,
    });
  }

  const { prepareAgentRunFinalization } =
    await import("@/lib/agents/finalization");
  const prepared = await prepareAgentRunFinalization(child.id, "Abandoned", {
    db,
    executionHosts: hosts,
    reason: `cascade/${reason}`,
    closeOpenHitl: true,
    closeAssignments: { kind: "system", reason: `cascade/${reason}` },
  });
  const settled = await db.transaction((tx) => prepared.apply(tx));

  await prepared.afterCommit(settled);

  return settled.finalized;
}

export interface CascadeAbandonResult {
  cascadedRunCount: number;
  abandonedTaskCount: number;
  // Ids of the runs this cascade actually flipped to Abandoned — what
  // `cascadeAbandonRunTreeAndStopSessions` tears down. The cascade only
  // mutates DB rows; sessions live in the supervisor.
  cascadedRunIds: string[];
}

export interface CascadeAndStopOptions extends CascadeAbandonOptions {
  // A supervisor listing the caller already holds; omitted → listed here.
  records?: readonly SupervisorSessionRecord[];
  // ADR-166: the caller's execution-host client (each teardown rides the
  // child's own fenced client); omitted → the process default.
  executionHosts?: ExecutionHosts;
  logLabel: string;
}

type CascadedRunRow = {
  id: string;
  projectId: string;
  taskId: string | null;
  flowId: string | null;
  runKind: string;
  parentRunId: string | null;
};

// Receipt-backed descendants confirm quiescence and settle through their
// finalizers. The remaining descendants and unlaunched tasks keep their atomic
// bulk transition. Retries skip descendants already settled.
//
// The orchestrator run ITSELF is NOT touched here — the caller flips it terminal
// (children-first ordering) right after. `promoteNextPending` runs AFTER the tx,
// once per pool that actually had a cascaded terminal, so freed flow/agent slots
// are reclaimed.
async function abandonRunSubtree(
  orchestratorRunId: string,
  orchestratorTaskId: string | null,
  reason: CascadeReason,
  opts: CascadeAbandonOptions = {},
): Promise<CascadeAbandonResult & { pendingTeardownIds: string[] }> {
  const database = opts.db ?? getDb();

  // Finding 1 (Codex adversarial review): revoke the orchestrator's run-bound
  // ext token as part of its teardown. abandon / stop / drop / reconcile-crash
  // all route through this cascade, but the normal-exit revoke
  // (runner-graph.ts) does NOT fire on these paths — so without this a stale
  // `orchestrator-run:<id>` token would stay usable under the terminal tree for
  // its TTL. Best-effort + idempotent (revoke-by-name); a no-op for a run that
  // never held an orchestrator token. Runs before the nothing-to-cascade
  // early-return so a childless orchestrator's token is still revoked.
  await revokeOrchestratorRunTokensForRun(orchestratorRunId, database).catch(
    () => {},
  );

  const subtreeIds = await getRunSubtreeIds(orchestratorRunId, database);
  const unlaunchedTaskIds = orchestratorTaskId
    ? await getUnlaunchedAutoChildTaskIds(orchestratorTaskId, database)
    : [];

  if (subtreeIds.length === 0 && unlaunchedTaskIds.length === 0) {
    log.debug(
      { orchestratorRunId, reason },
      "cascadeAbandonRunTree: nothing to cascade",
    );

    return {
      cascadedRunCount: 0,
      abandonedTaskCount: 0,
      cascadedRunIds: [],
      pendingTeardownIds: [],
    };
  }

  const children = subtreeIds.length
    ? await (database as ExecutionDb)
        .select()
        .from(executionRuns)
        .where(
          and(
            inArray(executionRuns.id, subtreeIds),
            inArray(executionRuns.status, [
              ...CASCADE_NON_TERMINAL_RUN_STATUSES,
            ]),
            sql`(${executionRuns.agentKind}='operational' OR (${executionRuns.companyId} IS NOT NULL AND ${executionRuns.runKind}='flow'))`,
          ),
        )
    : [];
  const receiptBackedIds: string[] = [];

  if (children.length) {
    const hosts = opts.executionHosts ?? createExecutionHosts({ db: database });
    const byId = new Map(children.map((child) => [child.id, child]));

    for (const id of [...subtreeIds].reverse()) {
      const child = byId.get(id);

      if (!child) continue;
      if (await abandonReceiptBackedChild(database, hosts, child, reason)) {
        receiptBackedIds.push(id);
        continue;
      }
      const [current] = await (database as ExecutionDb)
        .select({ status: executionRuns.status })
        .from(executionRuns)
        .where(eq(executionRuns.id, id));

      const unsettled: readonly Run["status"][] =
        CASCADE_NON_TERMINAL_RUN_STATUSES;

      if (current && unsettled.includes(current.status))
        throw new MaisterError(
          "CONFLICT",
          "Child teardown still has an active owner",
          {
            details: { reason: "cascade_child_unsettled", runId: id },
          },
        );
    }
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
                  sql`${runs.agentKind} IS DISTINCT FROM 'operational' AND (${runs.companyId} IS NULL OR ${runs.runKind}<>'flow')`,
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

      await abandonUnlaunchedTasks(tx, unlaunchedTaskIds, endedAt);

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

        // D-M1: an abandoned agent run's undelivered messages end with it, in
        // this transaction — the cascade never passes through finalization.
        const superseded = await supersedeUndispatchedMessageTurns(
          tx,
          runRows.filter((row) => row.runKind === "agent").map((row) => row.id),
          endedAt,
        );

        if (superseded.length > 0)
          log.info(
            { orchestratorRunId, reason, count: superseded.length },
            "agent-queued-turns-superseded",
          );
        for (const row of runRows) {
          await releaseAssignmentForRun(tx, row.id, "abandoned");
          await emitDomainEvent({
            db: tx,
            kind: "run.abandoned",
            projectId: row.projectId,
            runId: row.id,
            taskId: row.taskId,
            actor: { type: "system", id: null },
            parentRunId: row.parentRunId,
            cause: {
              code: null,
              reason: `cascade/${causeReason(reason)}`,
              source: "orchestrator",
            },
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
      cascadedRunCount: cascaded.length + receiptBackedIds.length,
      abandonedTaskCount: unlaunchedTaskIds.length,
      pools: [...pools],
    },
    "cascadeAbandonRunTree: sub-tree abandoned",
  );

  return {
    cascadedRunCount: cascaded.length + receiptBackedIds.length,
    abandonedTaskCount: unlaunchedTaskIds.length,
    cascadedRunIds: [...receiptBackedIds, ...cascaded.map((row) => row.id)],
    pendingTeardownIds: cascaded.map((row) => row.id),
  };
}

export async function cascadeAbandonRunTree(
  orchestratorRunId: string,
  orchestratorTaskId: string | null,
  reason: CascadeReason,
  opts: CascadeAbandonOptions = {},
): Promise<CascadeAbandonResult> {
  const { pendingTeardownIds: _pending, ...result } = await abandonRunSubtree(
    orchestratorRunId,
    orchestratorTaskId,
    reason,
    opts,
  );

  return result;
}

// Codex review F2 (ADR-163): the cascade flips rows; the graph runner never
// re-reads `runs.status`, so a cascaded child's live ACP session keeps spending
// and mutating its worktree under an `Abandoned` row unless someone stops it.
// ONE composition for every caller that cancels a tree (operator stop / drop,
// the coordinator's run_cancel of a child that itself orchestrates, the abandon
// route, the budget tree-terminate, the orphan-child compensation, the
// orchestrator-stuck crash) so no caller can take the rows and forget the
// sessions. Descendant rows flip before their teardown by construction — the
// reconcile sweep reaps whatever a crash or a supervisor hiccup leaves live.
export async function cascadeAbandonRunTreeAndStopSessions(
  orchestratorRunId: string,
  orchestratorTaskId: string | null,
  reason: CascadeReason,
  opts: CascadeAndStopOptions,
): Promise<CascadeAbandonResult> {
  const { pendingTeardownIds, ...result } = await abandonRunSubtree(
    orchestratorRunId,
    orchestratorTaskId,
    reason,
    { db: opts.db, executionHosts: opts.executionHosts },
  );

  await teardownLiveSessionsForRuns(pendingTeardownIds, {
    records: opts.records,
    logLabel: opts.logLabel,
    executionHosts: opts.executionHosts,
  });

  return result;
}
