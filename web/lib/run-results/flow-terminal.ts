import "server-only";

import type { RunResultContract, RunResultRow } from "@/lib/run-results/types";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { gcAgeDays } from "@/lib/instance-config";
import { isRunWorkspaceClean } from "@/lib/runs/workspace-clean";
import { deriveResultStatus } from "@/lib/run-results/status";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { runs, workspaces } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "run-result-terminal",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-165 (D10/D17): what `graph_completed` does once a run can carry a public
// result. Three exits, all inside the EXISTING terminal transaction:
//
//   failed_result_missing  a REQUIRED export produced nothing
//   done_result_only       a valid result + a workspace that changed nothing
//   review                 everything else, byte-identical to today
//
// The decision is computed BEFORE the transaction (the clean probe shells out to
// git, which must not run inside one) and applied inside it. That is safe
// because no session is live at the terminal branch and the run row's own CAS is
// what makes the flip single-winner.

export type FlowTerminalExit =
  | { exit: "failed_result_missing"; resultStatus: "missing" }
  | { exit: "done_result_only"; resultStatus: "valid" }
  | { exit: "review"; resultStatus: string };

export type FlowTerminalDecisionArgs = {
  runStatus: string;
  contract: RunResultContract | null;
  newest: RunResultRow | null;
  valid: RunResultRow | null;
  workspace: {
    worktreePath: string | null;
    branch: string | null;
    baseCommit: string | null;
  } | null;
};

/**
 * Decide which success exit a completed graph takes.
 *
 * `runStatus` is passed as the status the run is ABOUT to reach, not its current
 * one, so `deriveResultStatus` classifies against the settled vocabulary.
 */
export async function decideFlowTerminalExit(
  args: FlowTerminalDecisionArgs,
): Promise<FlowTerminalExit> {
  const { contract, newest, valid } = args;
  const resultStatus = deriveResultStatus({
    runStatus: "Review",
    contract,
    newestRow: newest,
    validRow: valid,
  });

  // A REQUIRED export that produced nothing is a contract failure, not missing
  // evidence — readiness is not consulted for it. Only `missing` qualifies:
  // `stale` and `invalid` mean the run DID publish, and failing those here
  // would swallow a rework that a human can still resolve at Review.
  if (contract?.required && resultStatus === "missing") {
    return { exit: "failed_result_missing", resultStatus: "missing" };
  }

  if (contract?.kind !== "flow_export" || resultStatus !== "valid") {
    return { exit: "review", resultStatus };
  }

  const cleanliness = await isRunWorkspaceClean({
    worktreePath: args.workspace?.worktreePath ?? null,
    branch: args.workspace?.branch ?? null,
    baseCommit: args.workspace?.baseCommit ?? null,
  });

  if (!cleanliness.clean) {
    log.debug(
      { reason: cleanliness.reason },
      "[run-result.terminal] workspace not clean — taking the Review exit",
    );

    return { exit: "review", resultStatus };
  }

  return { exit: "done_result_only", resultStatus: "valid" };
}

export type FinalizeDoneRow = {
  projectId: string;
  taskId: string | null;
  flowId: string | null;
  runKind: string;
  parentRunId: string | null;
};

/**
 * The result-only `Running -> Done` flip.
 *
 * Mirrors `promote.ts`'s own-tree Done write list with three deliberate
 * omissions — `promoted_head_sha`, `merge_commit_sha` and
 * `workspaces.promotion_state` — because nothing was promoted. `promotion_hold`
 * is not consulted for the same reason: there is no git side effect to hold
 * back. `scheduled_removal_at` IS stamped, so GC sees the ordinary shape.
 *
 * Returns the flipped row, or null when the CAS lost (another writer already
 * moved the run out of `Running`).
 */
export async function finalizeFlowRunDoneResultOnly(
  tx: Db,
  args: {
    runId: string;
    endedAt: Date;
    workspaceId: string | null;
  },
): Promise<FinalizeDoneRow | null> {
  const rows = (await tx
    .update(runs)
    .set({
      status: "Done",
      endedAt: args.endedAt,
      currentStepId: null,
      // The run is Done with nothing delivered — say so explicitly rather than
      // leaving a NULL that a reader would have to interpret.
      diffStat: { files: 0, additions: 0, deletions: 0 },
    })
    .where(and(eq(runs.id, args.runId), eq(runs.status, "Running")))
    .returning({
      projectId: runs.projectId,
      taskId: runs.taskId,
      flowId: runs.flowId,
      runKind: runs.runKind,
      parentRunId: runs.parentRunId,
    })) as FinalizeDoneRow[];

  if (rows.length === 0) return null;

  if (args.workspaceId) {
    await tx
      .update(workspaces)
      .set({
        scheduledRemovalAt: new Date(
          args.endedAt.getTime() + gcAgeDays() * 86_400_000,
        ),
      })
      .where(eq(workspaces.id, args.workspaceId));
  }

  return rows[0];
}

/** The webhook + domain pair a result-only completion emits. */
export async function emitResultOnlyDone(
  tx: Db,
  args: { runId: string; row: FinalizeDoneRow },
): Promise<void> {
  await emitWebhookEvent({
    db: tx,
    type: "run.done",
    projectId: args.row.projectId,
    runId: args.runId,
    data: {},
  });
  await emitDomainEvent({
    db: tx,
    kind: "run.done",
    projectId: args.row.projectId,
    runId: args.runId,
    taskId: args.row.taskId,
    actor: { type: "system", id: null },
    parentRunId: args.row.parentRunId,
    payload: {
      runId: args.runId,
      taskId: args.row.taskId,
      flowId: args.row.flowId,
      runKind: args.row.runKind,
      // ADR-165 (Q10-A): additive payload widening, no new kind. `completion`
      // is what tells a consumer this Done carries no promotion.
      completion: "result_only",
      resultStatus: "valid",
    },
  });
}

/** The workspace fields the terminal decision and the Done flip need. */
export type TerminalWorkspaceRef = {
  id: string;
  worktreePath: string | null;
  branch: string | null;
  baseCommit: string | null;
};

/**
 * The run's OWN workspace row, or null when it has none.
 *
 * Read once and passed to both the decision and the flip so the clean probe and
 * the `scheduled_removal_at` write can never target different rows.
 */
export async function loadRunWorkspaceForTerminal(
  db: Db,
  runId: string,
): Promise<TerminalWorkspaceRef | null> {
  const rows = (await db
    .select({
      id: workspaces.id,
      worktreePath: workspaces.worktreePath,
      branch: workspaces.branch,
      baseCommit: workspaces.baseCommit,
    })
    .from(workspaces)
    .where(eq(workspaces.runId, runId))
    .limit(1)) as TerminalWorkspaceRef[];

  return rows[0] ?? null;
}
