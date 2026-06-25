import "server-only";

import { and, eq, gte, inArray, notInArray, sql } from "drizzle-orm";
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
import { actorForUserId } from "@/lib/social/activity";
import { addTaskComment } from "@/lib/social/comments";
import { getOpenRelationBlockers } from "@/lib/social/relations";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, tasks } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "auto-launch-triaged",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-111 (level-triggered + cap): launch_mode='auto' is kept across a
// successful launch — a dependency-blocked task self-launches once its blocker
// clears, and a transient cap-hit is retried — but a flow that keeps FAILING
// must not relaunch forever. Two bounds applied per candidate:
//   - attempt cap: after MAX_AUTO_LAUNCH_ATTEMPTS failed flow runs the tick GIVES
//     UP (flags the task + comments) instead of launching again;
//   - backoff: after a failure it waits an exponentially-growing window keyed on
//     the last failed run's finishedAt before the next attempt.
const MAX_AUTO_LAUNCH_ATTEMPTS = 3;
const AUTO_LAUNCH_BACKOFF_BASE_SECONDS = 60;

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
  launchArmedAt: Date | null;
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

// Count of FAILED flow-run attempts for the task (Failed/Abandoned — the
// relaunchable-failure states the tick would otherwise retry). Crashed is held
// for human recover/discard and is never relaunched by the tick, so it does not
// count toward the cap. SCOPED to the CURRENT enqueue intent: only runs started
// at/after the task's launch_armed_at count, so old manual failures, failures
// under a PREVIOUS flow, and failures before a give-up→re-arm do NOT consume the
// new intent's attempt budget (else a freshly re-triaged task would be flagged
// without ever launching, breaking the give-up's "re-send to triage to retry").
// armedAt null (a legacy auto row armed before migration 0073) → count all.
async function countFailedFlowRuns(
  db: Db,
  taskId: string,
  armedAt: Date | null,
): Promise<number> {
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.taskId, taskId),
        eq(runs.runKind, "flow"),
        inArray(runs.status, ["Failed", "Abandoned"]),
        ...(armedAt ? [gte(runs.startedAt, armedAt)] : []),
      ),
    );

  return rows.length;
}

// The auto_launch_triaged tick (ADR-111): a triaged + launch_mode='auto' + flow
// task whose relation blockers have cleared is launched as a board flow run by
// reusing launchRun (which owns git/worktree + the run insert + supervisor
// spawn). DISJOINT from auto_launch_run_plan (ADR-098): that consumer launches
// AGENT runs for as-plan tasks (delegation_spec.agentId set, parent_of under an
// orchestrator); this tick excludes them (delegation_spec.agentId IS NULL,
// flow_id IS NOT NULL). Idempotency across overlapping invocations is the
// budget-1 singleton lease (the M24 clock claims at most one attempt) plus the
// per-task live-flow-run guard; the tick writes NO mark before launchRun.
//
// Level-triggered + cap (ADR-111): launch_mode='auto' is KEPT across a launch, so
// the same intent self-launches once a dependency clears and is retried after a
// transient refusal — but the failure cap + backoff (see countFailedFlowRuns /
// MAX_AUTO_LAUNCH_ATTEMPTS) stop a repeatedly-failing flow from relaunching
// forever.
//
// No-silent-stall give-up (ADR-111 / D9): a single candidate's refusal is logged
// and skipped, never thrown — a throw would mark the whole tick Skipped/Failed
// and redeliver. Give-up HOLDS the task (clears launch_mode, sets
// triage_status='flagged', posts a system comment) on either a TERMINAL refusal
// (PRECONDITION: flow disabled/untrusted post-triage, no enabled revision,
// target branch taken; or CONFIG: the revision is structurally unlaunchable —
// unsupported schema/engine, unknown role/capability/mcp ref) or the
// failure-attempt cap. A TRANSIENT refusal (cap → the run goes Pending, which
// launchRun RETURNS without throwing; or EXECUTOR_UNAVAILABLE) leaves
// launch_mode='auto' so the next tick retries.
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
      launchArmedAt: tasks.launchArmedAt,
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

      // Cap: a flow that has already failed too many times is given up (held for
      // a human) rather than relaunched forever.
      const failures = await countFailedFlowRuns(
        db,
        candidate.taskId,
        candidate.launchArmedAt,
      );

      if (failures >= MAX_AUTO_LAUNCH_ATTEMPTS) {
        const held = await giveUp(db, candidate, {
          reason: "auto_launch_attempts_exhausted",
          detail: `${failures} flow runs failed since this enqueue was armed`,
        });

        if (held) {
          summary.gaveUp += 1;
        } else {
          summary.skipped += 1;
        }
        continue;
      }

      // Backoff: after a failure, wait an exponentially-growing window (keyed on
      // the last failed run's endedAt) before the next attempt — transient,
      // launch_mode stays 'auto'.
      if (failures > 0 && latestRun?.endedAt) {
        const backoffMs =
          AUTO_LAUNCH_BACKOFF_BASE_SECONDS * 2 ** (failures - 1) * 1000;
        const readyAt = latestRun.endedAt.getTime() + backoffMs;

        if (Date.now() < readyAt) {
          log.debug(
            { taskId: candidate.taskId, failures, readyAt },
            "auto-launch-triaged: within failure backoff — wait",
          );
          summary.skipped += 1;
          continue;
        }
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
        const held = await giveUp(db, candidate, {
          reason: "auto_launch_stale_flow",
          detail: err instanceof Error ? err.message : String(err),
        });

        if (held) {
          summary.gaveUp += 1;
        } else {
          summary.skipped += 1;
        }
        continue;
      }

      // Transient refusal (EXECUTOR_UNAVAILABLE — the supervisor may come back;
      // or a CONFLICT redelivery race) — leave launch_mode='auto' so the next
      // tick retries. Never thrown (would redeliver the whole tick).
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

// A terminal, non-retryable refusal HOLDS the task (give-up), never loops:
//   - PRECONDITION: flow disabled/untrusted after triage, no enabled revision,
//     package not Installed, setup pending/failed, target branch taken — the task
//     is no longer launchable.
//   - CONFIG: the enabled revision is structurally unlaunchable — unsupported
//     manifest schemaVersion, incompatible engine, or an unknown flow-role /
//     capability / mcp ref / provider payload. Every CONFIG launchRun throws is a
//     misconfiguration that retrying can NEVER fix, so it must hold the task
//     (no-silent-stall), NOT WARN-spin every tick forever.
// EXECUTOR_UNAVAILABLE is transient (the supervisor may come back); CONFLICT is an
// idempotency race (a run already exists) — both stay 'auto' for the next tick.
function isTerminalLaunchRefusal(err: unknown): boolean {
  return (
    isMaisterError(err) &&
    (err.code === "PRECONDITION" || err.code === "CONFIG")
  );
}

// ADR-111 give-up (no-silent-stall, documented behavior): a triaged+auto task
// the tick can never successfully launch must not loop. Give-up HOLDS the task
// for a human in ONE transaction — it clears launch_mode (out of the candidate
// set), sets triage_status='flagged' (non-launchable even with a flow set), and
// posts a system comment carrying the reason. Both triggers converge here: a
// terminal PRECONDITION/CONFIG at launch (stale flow / branch taken / unlaunchable
// revision) and the failure-attempt cap. The write is a CAS over the selected
// (triaged, auto, flow) tuple: if an external action (a human clearing the flag,
// a re-triage, a flow change, sendToTriage) moved the task between selection and
// here, the give-up is stale → it writes nothing, posts no comment, and returns
// false (the caller counts it as skipped, not gaveUp). The comment emits
// task.comment_added, but the now-flagged state keeps the tick (and a well-behaved
// triager — see triager.md) from re-processing the task until a human clears it.
async function giveUp(
  db: Db,
  candidate: CandidateRow,
  opts: { reason: string; detail: string },
): Promise<boolean> {
  const held = await db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(tasks)
      .set({
        launchMode: null,
        triageStatus: "flagged",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tasks.id, candidate.taskId),
          eq(tasks.projectId, candidate.projectId),
          // CAS: only hold the task we actually selected — a newer external
          // decision (different triage_status / launch_mode / flow, or a re-arm
          // bumping launch_armed_at) is preserved, never clobbered.
          eq(tasks.triageStatus, "triaged"),
          eq(tasks.launchMode, "auto"),
          eq(tasks.flowId, candidate.flowId),
          ...(candidate.launchArmedAt
            ? [eq(tasks.launchArmedAt, candidate.launchArmedAt)]
            : []),
        ),
      )
      .returning({ id: tasks.id });

    if (rows.length === 0) {
      return false;
    }

    await addTaskComment(
      {
        taskId: candidate.taskId,
        body: `Auto-launch gave up (${opts.reason}): ${opts.detail}. This task is now flagged for review — clear the flag or re-send it to triage to retry.`,
        actor: actorForUserId(null),
        activityPayloadExtra: { reason: opts.reason, detail: opts.detail },
      },
      tx,
    );

    return true;
  });

  if (!held) {
    log.info(
      { taskId: candidate.taskId, reason: opts.reason },
      "auto-launch-triaged: give-up skipped — task changed since selection",
    );

    return false;
  }

  log.info(
    { taskId: candidate.taskId, reason: opts.reason },
    "auto-launch-triaged: gave up — flagged + commented",
  );

  return true;
}
