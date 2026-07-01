import "server-only";

import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  notInArray,
  sql,
} from "drizzle-orm";
import pino from "pino";

import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  classifyTaskLaunchability,
  getLatestFlowRun,
} from "@/lib/runs/launchability";
import { TERMINAL_RUN_STATUSES } from "@/lib/runs/run-status-sets";
import { actorForUserId } from "@/lib/social/activity";
import { addTaskComment } from "@/lib/social/comments";
import { getOpenRelationBlockers } from "@/lib/social/relations";
import { priorityWeightSql } from "@/lib/tasks/admission-selector";
import { type TaskPriority } from "@/lib/tasks/criticality";

const log = pino({
  name: "c2-eligibility",
  level: process.env.LOG_LEVEL ?? "info",
});

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, tasks } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

// ADR-121 §4.4 (F2/DRY): the C2 (fresh-Backlog-task) eligibility primitives are
// shared by BOTH consumers of the admission funnel — the 60s poll backstop
// (`auto-launch-triaged`) and the slot-free gate (`promoteNextPending`). Neither
// re-implements candidate selection, the failure cap, the backoff window, or the
// live-auto count: priority order, the reserve/maxInFlightAuto guards, pause, and
// the failure budget all resolve identically on both paths.

// ADR-112 (level-triggered + cap): a triaged+auto flow that keeps FAILING must not
// relaunch forever. After MAX_AUTO_LAUNCH_ATTEMPTS failed flow runs the funnel
// GIVES UP (the poll flags the task; the gate simply stops admitting it); after a
// failure it waits an exponentially-growing backoff window before the next attempt.
export const MAX_AUTO_LAUNCH_ATTEMPTS = 3;
export const AUTO_LAUNCH_BACKOFF_BASE_SECONDS = 60;

export type C2CandidateRow = {
  taskId: string;
  projectId: string;
  status: "Backlog" | "InFlight" | "Done" | "Abandoned";
  flowId: string | null;
  triageStatus: "triaged" | "flagged" | null;
  launchArmedAt: Date | null;
  priority: TaskPriority | null;
  createdAt: Date;
};

// The C2 candidate query: triaged + launch_mode='auto' + flow + NOT paused tasks,
// DISJOINT from the orchestrator as-plan source (delegation_spec.agentId NULL, not
// a parent_of child). Ordered by the criticality dictionary (weight DESC) then FIFO
// (created_at ASC) so the most critical eligible Backlog task drains first.
export async function loadC2CandidateRows(db: Db): Promise<C2CandidateRow[]> {
  return db
    .select({
      taskId: tasks.id,
      projectId: tasks.projectId,
      status: tasks.status,
      flowId: tasks.flowId,
      triageStatus: tasks.triageStatus,
      launchArmedAt: tasks.launchArmedAt,
      priority: tasks.priority,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.triageStatus, "triaged"),
        eq(tasks.launchMode, "auto"),
        // ADR-121 (INV-10): a paused task is never auto-admitted (C2) or polled.
        eq(tasks.queuePaused, false),
        // flow_id present → a triaged-enqueue task, not an as-plan one.
        sql`${tasks.flowId} IS NOT NULL`,
        // DISJOINT from auto_launch_run_plan: an as-plan task carries a
        // delegation_spec.agentId (the agent target the auto-DAG launches).
        sql`(${tasks.delegationSpec} -> 'agentId') IS NULL`,
        // Belt for disjointness: never a parent_of child of an orchestrator.
        sql`NOT EXISTS (
          SELECT 1 FROM task_relations tr
          WHERE tr.to_task_id = ${tasks.id} AND tr.kind = 'parent_of'
        )`,
      ),
    )
    .orderBy(
      sql`${priorityWeightSql(tasks.priority)} desc`,
      asc(tasks.createdAt),
    );
}

// ADR-121 (F1/Codex-2): GLOBAL count of outstanding C2 admission claims
// (tasks.queue_claimed_at NOT NULL, any project). A C2 claim reserves a flow-pool
// slot BEFORE its run row exists (worktree-first launchRun), so the reserve guard
// (INV-8) MUST count claims on top of live runs — otherwise concurrent slot-free
// gate calls, serialized on the scheduler lock, each see the same unchanged
// countLiveRuns and over-admit past `flowCap − reserve`. Counted under the lock so
// a serialized caller observes the prior caller's committed claim.
export async function countOutstandingC2Claims(db: Db): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(tasks)
    .where(isNotNull(tasks.queueClaimedAt));

  return Number(rows[0]?.n ?? 0);
}

// True when the task already has a NON-terminal flow run (one flow run at a time).
export async function hasLiveFlowRun(db: Db, taskId: string): Promise<boolean> {
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

// Count of FAILED flow-run attempts (Failed/Abandoned) for the task, SCOPED to the
// current enqueue intent (>= launch_armed_at). Crashed is held for human recover
// and never relaunched, so it does not count. armedAt null (legacy) → count all.
export async function countFailedFlowRuns(
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

// ADR-121 (INV-9, F1): live auto-DRAINED flow runs for a project = funnel-minted
// runs (queue_admitted_at NOT NULL, non-terminal) PLUS outstanding C2 claims
// (tasks.queue_claimed_at NOT NULL) — counting in-flight claims keeps the per-project
// cap honored during the worktree window. A manual / scratch / ADR-119
// force-relaunch run carries no queue_admitted_at and is correctly excluded.
export async function countLiveAutoFlowRuns(
  db: Db,
  projectId: string,
): Promise<number> {
  const admittedRows = await db
    .select({ n: count() })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, projectId),
        eq(runs.runKind, "flow"),
        isNotNull(runs.queueAdmittedAt),
        notInArray(runs.status, [...TERMINAL_RUN_STATUSES]),
      ),
    );
  const claimRows = await db
    .select({ n: count() })
    .from(tasks)
    .where(
      and(eq(tasks.projectId, projectId), isNotNull(tasks.queueClaimedAt)),
    );

  return Number(admittedRows[0]?.n ?? 0) + Number(claimRows[0]?.n ?? 0);
}

// True when a failed candidate is still inside its exponentially-growing backoff
// window (transient — the intent stays auto, the next tick retries past the window).
export function isWithinFailureBackoff(
  failures: number,
  latestEndedAt: Date | null | undefined,
  nowMs: number,
): boolean {
  if (failures <= 0 || !latestEndedAt) return false;
  const backoffMs =
    AUTO_LAUNCH_BACKOFF_BASE_SECONDS * 2 ** (failures - 1) * 1000;

  return nowMs < latestEndedAt.getTime() + backoffMs;
}

export type C2Eligibility =
  | { kind: "eligible" }
  | { kind: "skip" }
  | { kind: "give-up"; failures: number };

// The per-candidate C2 eligibility verdict shared by both consumers. Applies, in
// order: the live-flow-run guard, launchability (incl. open relation blockers), the
// failure-attempt cap (→ give-up), and the failure backoff (→ skip). It does NOT
// apply the capacity guards (reserve / maxInFlightAuto / edgeDrain) — those are
// stateful per-admission and resolved by each consumer in its own loop.
export async function evaluateC2Candidate(
  db: Db,
  candidate: C2CandidateRow,
  nowMs: number,
): Promise<C2Eligibility> {
  if (await hasLiveFlowRun(db, candidate.taskId)) {
    return { kind: "skip" };
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
    return { kind: "skip" };
  }

  const failures = await countFailedFlowRuns(
    db,
    candidate.taskId,
    candidate.launchArmedAt,
  );

  if (failures >= MAX_AUTO_LAUNCH_ATTEMPTS) {
    return { kind: "give-up", failures };
  }

  if (isWithinFailureBackoff(failures, latestRun?.endedAt ?? null, nowMs)) {
    return { kind: "skip" };
  }

  return { kind: "eligible" };
}

// A terminal, non-retryable launchRun refusal HOLDS the task (give-up), never
// loops: PRECONDITION (flow disabled/untrusted, no enabled revision, branch taken)
// or CONFIG (structurally unlaunchable revision). EXECUTOR_UNAVAILABLE is transient
// and CONFLICT is an idempotency race — both stay 'auto'/re-eligible for retry.
export function isTerminalLaunchRefusal(err: unknown): boolean {
  return (
    isMaisterError(err) &&
    (err.code === "PRECONDITION" || err.code === "CONFIG")
  );
}

// ADR-121 F1: clear the two-phase C2 claim. Called once the run row exists (its
// busy status now serializes against double-mint) OR on launchRun failure (so the
// task is re-eligible next tick). Idempotent.
export async function clearC2Claim(db: Db, taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({ queueClaimedAt: null })
    .where(eq(tasks.id, taskId));
}

// ADR-112 give-up (no-silent-stall): a triaged+auto task the funnel can never
// successfully launch must not loop. Shared by the poll backstop AND the slot-free
// gate (a terminal PRECONDITION/CONFIG never creates a Failed run, so the
// failure-cap path alone cannot catch it — the gate must give up too). HOLDS the
// task for a human in ONE transaction (clears launch_mode, flags, posts a system
// comment). The write is a CAS over the selected (triaged, auto, flow) tuple: a
// concurrent external change makes the give-up stale → writes nothing, returns
// false (the caller counts it as skipped, not gaveUp).
export async function giveUpC2Task(
  db: Db,
  candidate: Pick<
    C2CandidateRow,
    "taskId" | "projectId" | "flowId" | "launchArmedAt"
  >,
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
      "c2 give-up skipped — task changed since selection",
    );

    return false;
  }

  log.info(
    { taskId: candidate.taskId, reason: opts.reason },
    "c2 gave up — flagged + commented",
  );

  return true;
}
