import "server-only";

import { inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  countLiveAutoFlowRuns,
  countOutstandingC2Claims,
  evaluateC2Candidate,
  giveUpC2Task,
  isTerminalLaunchRefusal,
  loadC2CandidateRows,
} from "@/lib/scheduler/c2-eligibility";
import { capForPool, countLiveRuns } from "@/lib/scheduler";
import { launchRun } from "@/lib/services/runs";
import {
  projectShareAllowsC2,
  reserveAllowsC2,
} from "@/lib/tasks/admission-selector";
import {
  resolveAutoReserve,
  resolveEdgeDrain,
  resolveMaxInFlightAuto,
  type TaskQueueSettings,
} from "@/lib/tasks/queue-settings";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects } = schemaModule as unknown as Record<string, any>;

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

export type AutoLaunchTriagedSummary = {
  candidates: number;
  launched: number;
  skipped: number;
  gaveUp: number;
};

// The auto_launch_triaged tick (ADR-112): a triaged + launch_mode='auto' + flow
// task whose relation blockers have cleared is launched as a board flow run by
// reusing launchRun (which owns git/worktree + the run insert + supervisor
// spawn). DISJOINT from auto_launch_run_plan (ADR-098): that consumer launches
// AGENT runs for as-plan tasks (delegation_spec.agentId set, parent_of under an
// orchestrator); this tick excludes them. Idempotency across overlapping
// invocations is the budget-1 singleton lease (the M24 clock claims at most one
// attempt) plus the per-task live-flow-run guard.
//
// ADR-121: this tick is the BACKSTOP of the unified C2 funnel — the slot-free
// `promoteNextPending` gate admits eligible Backlog tasks immediately, and this
// 60s tick catches anything a missed slot-free event left behind. Both paths share
// the SAME selection primitives (`@/lib/scheduler/c2-eligibility`) and capacity
// guards, so priority order, the reserve (INV-8), per-project maxInFlightAuto
// (INV-9), pause (INV-10), the failure cap, and backoff apply identically.
//
// No-silent-stall give-up (ADR-112 / D9): a single candidate's refusal is logged
// and skipped, never thrown. Give-up HOLDS the task (clears launch_mode, sets
// triage_status='flagged', posts a system comment) on either a TERMINAL refusal
// (PRECONDITION / CONFIG) or the failure-attempt cap. A TRANSIENT refusal (cap →
// the run goes Pending, which launchRun RETURNS without throwing; or
// EXECUTOR_UNAVAILABLE) leaves launch_mode='auto' so the next tick retries.
export async function runAutoLaunchTriagedJob(
  opts: { db?: Db; launch?: LaunchFn } = {},
): Promise<AutoLaunchTriagedSummary> {
  const db = opts.db ?? getDb();
  const launch = opts.launch ?? launchRun;

  const candidates = await loadC2CandidateRows(db);

  const summary: AutoLaunchTriagedSummary = {
    candidates: candidates.length,
    launched: 0,
    skipped: 0,
    gaveUp: 0,
  };

  // ADR-121 capacity context (computed once, then tracked per launch this tick).
  const flowCap = capForPool("flow");
  const reserve = resolveAutoReserve();
  // Count live flow runs PLUS outstanding slot-free-gate C2 claims (Codex-2), so
  // the poll's reserve guard is consistent with the gate's when both run.
  let liveFlow =
    (await countLiveRuns(db, "flow")) + (await countOutstandingC2Claims(db));

  const projectIds = [...new Set(candidates.map((c) => c.projectId))];
  const projectRows: Array<{
    id: string;
    taskQueueSettings: TaskQueueSettings | null;
  }> = projectIds.length
    ? await db
        .select({
          id: projects.id,
          taskQueueSettings: projects.taskQueueSettings,
        })
        .from(projects)
        .where(inArray(projects.id, projectIds))
    : [];
  const settingsByProject = new Map(
    projectRows.map((r) => [r.id, { taskQueueSettings: r.taskQueueSettings }]),
  );
  const liveAutoByProject = new Map<string, number>();

  async function liveAutoFor(projectId: string): Promise<number> {
    if (!liveAutoByProject.has(projectId)) {
      liveAutoByProject.set(
        projectId,
        await countLiveAutoFlowRuns(db, projectId),
      );
    }

    return liveAutoByProject.get(projectId) ?? 0;
  }

  const nowMs = Date.now();

  for (const candidate of candidates) {
    try {
      const eligibility = await evaluateC2Candidate(db, candidate, nowMs);

      if (eligibility.kind === "give-up") {
        const held = await giveUpC2Task(db, candidate, {
          reason: "auto_launch_attempts_exhausted",
          detail: `${eligibility.failures} flow runs failed since this enqueue was armed`,
        });

        if (held) summary.gaveUp += 1;
        else summary.skipped += 1;
        continue;
      }

      if (eligibility.kind === "skip") {
        summary.skipped += 1;
        continue;
      }

      // ADR-121 C2 capacity guards (the slot-free gate applies these identically).
      // edgeDrain is per-project; the reserve + share guards keep auto-drain inside
      // its budget. These are stateful per-admission, so they live in this loop.
      const projectSettings = settingsByProject.get(candidate.projectId) ?? {
        taskQueueSettings: null,
      };

      if (!resolveEdgeDrain(projectSettings)) {
        log.debug(
          { taskId: candidate.taskId, projectId: candidate.projectId },
          "auto-launch-triaged: edgeDrain off for project — skip (INV-7)",
        );
        summary.skipped += 1;
        continue;
      }

      if (!reserveAllowsC2(liveFlow, flowCap, reserve)) {
        log.debug(
          { taskId: candidate.taskId, liveFlow, flowCap, reserve },
          "auto-launch-triaged: flow-pool reserve held — skip (INV-8)",
        );
        summary.skipped += 1;
        continue;
      }

      const liveAuto = await liveAutoFor(candidate.projectId);
      const maxInFlightAuto = resolveMaxInFlightAuto(projectSettings);

      if (!projectShareAllowsC2(liveAuto, maxInFlightAuto)) {
        log.debug(
          {
            taskId: candidate.taskId,
            projectId: candidate.projectId,
            liveAuto,
            maxInFlightAuto,
          },
          "auto-launch-triaged: per-project maxInFlightAuto reached — skip (INV-9)",
        );
        summary.skipped += 1;
        continue;
      }

      const result = await launch(
        { taskId: candidate.taskId, queueAdmitted: true },
        { authorize: async () => {}, actorUserId: null },
        db,
      );

      // Track the budget consumed THIS tick so later candidates honor the guards.
      liveFlow += 1;
      liveAutoByProject.set(candidate.projectId, liveAuto + 1);
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
        const held = await giveUpC2Task(db, candidate, {
          reason: "auto_launch_stale_flow",
          detail: err instanceof Error ? err.message : String(err),
        });

        if (held) summary.gaveUp += 1;
        else summary.skipped += 1;
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
