import "server-only";

import { and, eq, notInArray, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  classifyTaskLaunchability,
  getLatestFlowRun,
} from "@/lib/runs/launchability";
import { TERMINAL_RUN_STATUSES } from "@/lib/runs/run-status-sets";
import { launchRun } from "@/lib/services/runs";
import { actorForUserId, recordTaskActivity } from "@/lib/social/activity";
import { getOpenRelationBlockers } from "@/lib/social/relations";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, tasks } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "auto-launch-triaged",
  level: process.env.LOG_LEVEL ?? "info",
});

type LaunchFn = (
  input: Parameters<typeof launchRun>[0],
  ctx: Parameters<typeof launchRun>[1],
  db?: Db,
) => Promise<{ runId: string; status: string; queuePosition?: number }>;

type CandidateRow = {
  taskId: string;
  projectId: string;
  status: "Backlog" | "InFlight" | "Done" | "Abandoned";
  flowId: string | null;
  triageStatus: "triaged" | "flagged" | null;
};

export type AutoLaunchTriagedSummary = {
  candidates: number;
  launched: number;
  skipped: number;
  gaveUp: number;
};

// True when the task already has a NON-terminal flow run. A triaged+auto task
// launches one flow run at a time, so a live flow run means the tick must not
// spawn another. The per-candidate classifier already reads `busy` from the
// latest flow run, but this guard keeps the candidate set selective (and mirrors
// the auto-launch consumer's hasAnyRun belt).
async function hasLiveFlowRun(db: Db, taskId: string): Promise<boolean> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.runKind, "flow"),
        notInArray(runs.status, [...TERMINAL_RUN_STATUSES]),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

// The auto_launch_triaged tick (ADR-111): a triaged + launch_mode='auto' + flow
// task whose relation blockers have cleared is launched as a board flow run by
// reusing launchRun (which owns git/worktree + the run insert + supervisor
// spawn). DISJOINT from auto_launch_run_plan (ADR-098): that consumer launches
// AGENT runs for as-plan tasks (delegation_spec.agentId set, parent_of under an
// orchestrator); this tick excludes them (delegation_spec.agentId IS NULL,
// flow_id IS NOT NULL). Idempotency = the per-task live-flow-run guard + the
// budget-1 singleton scheduling. The tick writes NO mark before launchRun.
//
// No-silent-stall give-up (ADR-111 / D9): a single candidate's refusal is logged
// and skipped, never thrown — a throw would mark the whole tick Skipped/Failed
// and redeliver. A TERMINAL refusal (PRECONDITION: flow disabled/untrusted
// post-triage, target branch taken, task became non-launchable) clears
// launch_mode (back to manual-launchable) + records a triage_requeued activity
// so the task is not retried forever. A TRANSIENT refusal (cap → the run goes
// Pending, which launchRun RETURNS without throwing; or EXECUTOR_UNAVAILABLE)
// leaves launch_mode='auto' so the next tick retries.
export async function runAutoLaunchTriagedJob(
  opts: { db?: Db; launch?: LaunchFn } = {},
): Promise<AutoLaunchTriagedSummary> {
  const db = opts.db ?? getDb();
  const launch = opts.launch ?? launchRun;

  const candidates: CandidateRow[] = await db
    .select({
      taskId: tasks.id,
      projectId: tasks.projectId,
      status: tasks.status,
      flowId: tasks.flowId,
      triageStatus: tasks.triageStatus,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.triageStatus, "triaged"),
        eq(tasks.launchMode, "auto"),
        // flow_id present → this is a triaged-enqueue task, not an as-plan one.
        sql`${tasks.flowId} IS NOT NULL`,
        // DISJOINT from auto_launch_run_plan: an as-plan task carries a
        // delegation_spec.agentId (the agent target the auto-DAG launches).
        sql`(${tasks.delegationSpec} -> 'agentId') IS NULL`,
        // Belt for the disjointness: never pick a parent_of child of an
        // orchestrator (those are the as-plan tasks).
        sql`NOT EXISTS (
          SELECT 1 FROM task_relations tr
          WHERE tr.to_task_id = ${tasks.id} AND tr.kind = 'parent_of'
        )`,
      ),
    );

  const summary: AutoLaunchTriagedSummary = {
    candidates: candidates.length,
    launched: 0,
    skipped: 0,
    gaveUp: 0,
  };

  for (const candidate of candidates) {
    try {
      if (await hasLiveFlowRun(db, candidate.taskId)) {
        log.debug(
          { taskId: candidate.taskId },
          "auto-launch-triaged: live flow run present — skip",
        );
        summary.skipped += 1;
        continue;
      }

      const latestRun = await getLatestFlowRun(candidate.taskId, db);
      const openBlockers =
        (await getOpenRelationBlockers([candidate.taskId], db)).get(
          candidate.taskId,
        ) ?? [];
      const launchability = classifyTaskLaunchability(
        {
          status: candidate.status,
          flowId: candidate.flowId,
          triageStatus: candidate.triageStatus,
        },
        latestRun,
        { openBlockers },
      );

      if (launchability !== "launchable") {
        log.debug(
          { taskId: candidate.taskId, launchability },
          "auto-launch-triaged: candidate not launchable — skip",
        );
        summary.skipped += 1;
        continue;
      }

      const result = await launch(
        { taskId: candidate.taskId },
        { authorize: async () => {}, actorUserId: null },
        db,
      );

      summary.launched += 1;
      log.info(
        {
          taskId: candidate.taskId,
          runId: result.runId,
          status: result.status,
          queuePosition: result.queuePosition,
        },
        "auto-launch-triaged: launched",
      );
    } catch (err) {
      if (isTerminalLaunchRefusal(err)) {
        await giveUp(db, candidate, err);
        summary.gaveUp += 1;
        continue;
      }

      // Transient refusal (EXECUTOR_UNAVAILABLE, CONFLICT redelivery race, or
      // any non-PRECONDITION) — leave launch_mode='auto' so the next tick
      // retries. Never thrown (would redeliver the whole tick).
      summary.skipped += 1;
      log.warn(
        {
          taskId: candidate.taskId,
          code: isMaisterError(err) ? err.code : "UNKNOWN",
          err: err instanceof Error ? err.message : String(err),
        },
        "auto-launch-triaged: candidate launch refused (transient) — stays auto",
      );
    }
  }

  log.info(summary, "auto-launch-triaged tick completed");

  return summary;
}

// A terminal, non-retryable refusal: PRECONDITION (flow disabled/untrusted after
// triage, target branch taken, the task is no longer launchable). EXECUTOR_
// UNAVAILABLE is transient (the supervisor may come back); CONFLICT is an
// idempotency race (a run already exists). Only PRECONDITION gives up.
function isTerminalLaunchRefusal(err: unknown): boolean {
  return isMaisterError(err) && err.code === "PRECONDITION";
}

async function giveUp(
  db: Db,
  candidate: CandidateRow,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);

  await db.transaction(async (tx: Db) => {
    await tx
      .update(tasks)
      .set({ launchMode: null, updatedAt: new Date() })
      .where(
        and(
          eq(tasks.id, candidate.taskId),
          eq(tasks.projectId, candidate.projectId),
        ),
      );

    await recordTaskActivity(tx, {
      taskId: candidate.taskId,
      projectId: candidate.projectId,
      actor: actorForUserId(null),
      eventKind: "triage_requeued",
      payload: {
        reason: "auto_launch_gave_up",
        code: isMaisterError(err) ? err.code : "UNKNOWN",
        message,
      },
    });
  });

  log.info(
    { taskId: candidate.taskId, reason: message },
    "auto-launch-triaged: gave up on a stale flow — cleared launch_mode",
  );
}
