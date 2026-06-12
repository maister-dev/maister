import "server-only";

import type { RunResumedSessionOptions } from "@/lib/runs/resume-driver";
import type { CreateSessionInput } from "@/lib/supervisor-client";

import { and, count, eq, inArray } from "drizzle-orm";
import pino from "pino";

import {
  mergeRunnerAdapterLaunch,
  runnerExecutorInput,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { resolveNodeRecoverInfo } from "@/lib/flows/graph/current-node-kind";
import { classifyRecover } from "@/lib/runs/recover-classify";
import { scheduleResumedSessionDrive } from "@/lib/runs/resume-driver";
import { crashRunningRun } from "@/lib/runs/state-transitions";
import { takeSchedulerLock } from "@/lib/scheduler";
import { createSession } from "@/lib/supervisor-client";

// Re-export the pure classifier from its canonical home so existing importers
// (`@/lib/runs/recover`) keep working — the run-detail projection imports it
// directly from `recover-classify` to avoid pulling this server-only graph.
export { classifyRecover };
export type { NodeKind, RecoverPlan } from "@/lib/runs/recover-classify";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects, runs, workspaces } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "run-recover",
  level: process.env.LOG_LEVEL ?? "info",
});

// M34: mirrors the scheduler's owner-requested default bump 3 → 6.
const DEFAULT_CAP = 6;

// Mirror scheduler's capFromEnv() — kept local so recover is self-contained.
function capFromEnv(): number {
  const raw = process.env.MAISTER_MAX_CONCURRENT_RUNS;

  if (!raw) return DEFAULT_CAP;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CAP;

  return parsed;
}

export function recoveredRunLaunchInput(run: {
  runnerSnapshot: Parameters<typeof runnerExecutorInput>[0] | null;
}): Pick<CreateSessionInput, "adapterLaunch" | "executor" | "runner"> | null {
  if (run.runnerSnapshot) {
    return {
      executor: runnerExecutorInput(run.runnerSnapshot),
      runner: runnerSupervisorInput({ snapshot: run.runnerSnapshot }),
      adapterLaunch: mergeRunnerAdapterLaunch(run.runnerSnapshot),
    };
  }

  return null;
}

// --- T3.2: resumeCrashedRun + driveResume ---------------------------------

export type RecoverResult =
  | { state: "resumed" }
  | { state: "redispatched" }
  | { state: "queued" }
  | { state: "discard-only" }
  | { state: "conflict" }
  | { state: "unresumable" }
  | { state: "transient" };

// Crash-recover signal threaded into runFlow so the runner resumes FROM the
// crashed node (re-runs it once) instead of no-op'ing or restarting from entry.
export type RunFlowResumeOpts = { crashResume?: { targetStepId: string } };

export interface ResumeCrashedRunOptions {
  db?: Db;
  createSession?: typeof createSession;
  scheduleResumedSessionDrive?: (o: RunResumedSessionOptions) => string;
  runFlow?: (id: string, runOpts?: RunFlowResumeOpts) => Promise<void> | void;
  now?: () => Date;
}

// §3.2 durable-marker-first + cap re-admission. Phase 1 is a SINGLE
// transaction: take the scheduler advisory lock, FOR-UPDATE the run, status-
// guard on Crashed, resolve the recovery plan, and either flip Crashed→Pending
// (cap full → queued) or Crashed→Running (slot free) via a status-guarded CAS.
// The durable marker commits BEFORE any supervisor side-effect — driveResume
// (Phase 2) runs only after commit on the slot-free path.
export async function resumeCrashedRun(
  runId: string,
  opts: ResumeCrashedRunOptions = {},
): Promise<RecoverResult> {
  const db = opts.db ?? getDb();
  const now = opts.now ?? (() => new Date());
  const cap = capFromEnv();

  // Phase-1 commit outcome: either a terminal RecoverResult (no side-effect
  // needed) or the `drive` marker meaning the slot-free Crashed→Running flip
  // committed and Phase 2 must run.
  type Phase1 = RecoverResult | { state: "drive" };

  const phase1: Phase1 = await db.transaction(async (tx: Db) => {
    await takeSchedulerLock(tx);

    const rows = await tx
      .select({
        id: runs.id,
        status: runs.status,
        acpSessionId: runs.acpSessionId,
        currentStepId: runs.currentStepId,
        resumeTargetStepId: runs.resumeTargetStepId,
        flowId: runs.flowId,
        flowRevisionId: runs.flowRevisionId,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");

    const run = rows[0];

    // Not found OR not Crashed → conflict (no side-effect). Covers the
    // concurrent-2nd-recover loser (CAS lost) and the not-Crashed guard.
    if (!run || run.status !== "Crashed") {
      log.warn(
        { runId, status: run?.status ?? "missing" },
        "resumeCrashedRun: not Crashed — conflict",
      );

      return { state: "conflict" };
    }

    // The recover target is the node id retained at crash time
    // (resume_target_step_id; current_step_id is nulled on a clean crash),
    // falling back to current_step_id for live/hand-seeded rows.
    const resumeTarget = run.resumeTargetStepId ?? run.currentStepId;
    const { nodeKind, retrySafe } = await resolveNodeRecoverInfo(tx, {
      flowRevisionId: run.flowRevisionId,
      flowId: run.flowId,
      stepId: resumeTarget,
    });
    const plan = classifyRecover(
      { acpSessionId: run.acpSessionId },
      nodeKind,
      retrySafe,
    );

    if (plan === "discard-only") {
      log.info(
        { runId, nodeKind, retrySafe },
        "resumeCrashedRun: no resumable target (agent w/o session, or session-less not retry_safe) — discard-only",
      );

      return { state: "discard-only" };
    }

    const liveRows: Array<{ count: number }> = await tx
      .select({ count: count() })
      .from(runs)
      .where(
        and(
          inArray(runs.status, ["Running", "NeedsInput", "HumanWorking"]),
          // M34: recover gates against the flow/scratch pool only — agent
          // runs hold their own budget and must not block a flow recover.
          inArray(runs.runKind, ["flow", "scratch"]),
        ),
      );
    const liveCount = Number(liveRows[0]?.count ?? 0);
    const at = now();

    if (liveCount >= cap) {
      // Cap full → re-admit into the Pending queue, KEEPING acpSessionId so
      // promoteNextPending resumes (not re-runs) it. NO createSession here.
      const updated = await tx
        .update(runs)
        .set({
          status: "Pending",
          resumeStartedAt: at,
          currentStepId: resumeTarget,
        })
        .where(and(eq(runs.id, runId), eq(runs.status, "Crashed")))
        .returning({ id: runs.id });

      if (updated.length === 0) return { state: "conflict" };

      log.info(
        { runId, liveCount, cap },
        "resumeCrashedRun: cap full → queued",
      );

      return { state: "queued" };
    }

    // Slot free → durable flip Crashed→Running BEFORE the side-effect.
    const updated = await tx
      .update(runs)
      .set({
        status: "Running",
        resumeStartedAt: at,
        currentStepId: resumeTarget,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "Crashed")))
      .returning({ id: runs.id });

    if (updated.length === 0) return { state: "conflict" };

    log.info(
      { runId, liveCount, cap },
      "resumeCrashedRun: slot free → Running",
    );

    return { state: "drive" };
  });

  // Terminal Phase-1 outcomes (no side-effect required).
  if (phase1.state !== "drive") {
    return phase1;
  }

  // Slot-free path: drive the Phase-2 side-effect against the already-Running run.
  return await driveResume(runId, opts);
}

// Phase 2 side-effect: the run is already Running (durable marker committed).
// Loads the run + workspace + project + executor, resolves the plan, and either
// re-dispatches a session-less gate node (runFlow) or re-issues the agent
// session via createSession({resumeSessionId}). Safe to call standalone on an
// already-Running run — it is also the scheduler's resume callback.
export async function driveResume(
  runId: string,
  opts: ResumeCrashedRunOptions = {},
): Promise<{
  state: "resumed" | "redispatched" | "unresumable" | "transient";
}> {
  const db = opts.db ?? getDb();
  const createSessionFn = opts.createSession ?? createSession;
  const driveFn =
    opts.scheduleResumedSessionDrive ?? scheduleResumedSessionDrive;

  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      acpSessionId: runs.acpSessionId,
      currentStepId: runs.currentStepId,
      resumeTargetStepId: runs.resumeTargetStepId,
      runnerSnapshot: runs.runnerSnapshot,
      projectId: runs.projectId,
      flowId: runs.flowId,
      flowRevisionId: runs.flowRevisionId,
      worktreePath: workspaces.worktreePath,
      projectSlug: projects.slug,
    })
    .from(runs)
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(runs.id, runId));
  const run = rows[0];

  if (!run) {
    log.error({ runId }, "driveResume: run row vanished after flip");

    return { state: "unresumable" };
  }

  // Phase-1 set current_step_id to the recover target; fall back to the retained
  // marker if driveResume is entered standalone.
  const resumeTarget = run.currentStepId ?? run.resumeTargetStepId;
  const { nodeKind, retrySafe } = await resolveNodeRecoverInfo(db, {
    flowRevisionId: run.flowRevisionId,
    flowId: run.flowId,
    stepId: resumeTarget,
  });
  const plan = classifyRecover(
    { acpSessionId: run.acpSessionId },
    nodeKind,
    retrySafe,
  );

  if (plan === "redispatch") {
    const runFlowFn =
      opts.runFlow ??
      (async (id: string, runOpts?: RunFlowResumeOpts) => {
        const mod = await import("@/lib/flows/runner");

        await mod.runFlow(id, runOpts);
      });

    // Explicit crash-recover signal: the runner resumes FROM this node (re-runs
    // it once) instead of no-op'ing (graph) or restarting from step 0 (linear).
    await runFlowFn(
      runId,
      resumeTarget
        ? { crashResume: { targetStepId: resumeTarget } }
        : undefined,
    );
    log.info(
      { runId, targetStepId: resumeTarget },
      "driveResume: session-less retry_safe node → redispatched (resume from node)",
    );

    return { state: "redispatched" };
  }

  // resume-agent: re-issue the prior session via --resume <acpSessionId>.
  const launch = recoveredRunLaunchInput(run);

  if (!launch) {
    log.error({ runId }, "driveResume: no runner snapshot or legacy executor");
    await crashRunningRun(runId, "agent-session-gone", { db });

    return { state: "unresumable" };
  }
  const stepId = run.currentStepId ?? "resume";

  try {
    const input: CreateSessionInput = {
      runId,
      projectSlug: run.projectSlug,
      worktreePath: run.worktreePath,
      stepId,
      executor: launch.executor,
      runner: launch.runner,
      resumeSessionId: run.acpSessionId ?? undefined,
      adapterLaunch: launch.adapterLaunch,
    };
    const result = await createSessionFn(input);

    if (!result.acpSessionId) {
      log.error(
        { runId, supervisorSessionId: result.sessionId },
        "driveResume: supervisor returned empty acpSessionId — unresumable",
      );
      await crashRunningRun(runId, "agent-session-gone", { db });

      return { state: "unresumable" };
    }

    driveFn({
      runId,
      supervisorSessionId: result.sessionId,
      acpSessionId: result.acpSessionId,
      stepId,
      db,
    });

    log.info(
      { runId, supervisorSessionId: result.sessionId },
      "driveResume: agent session re-issued via --resume",
    );

    return { state: "resumed" };
  } catch (err) {
    // Transient (supervisor 5xx / network) → leave Running, NO rollback; an
    // operator/sweeper can retry.
    if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
      log.warn(
        { runId, err: err.message },
        "driveResume: transient supervisor failure — leaving Running",
      );

      return { state: "transient" };
    }

    // CHECKPOINT (or any other) → the ACP session is unresumable. Crash the
    // Running run (clears resume_started_at) so the row is cleanly terminal.
    const msg = err instanceof Error ? err.message : String(err);

    log.warn(
      { runId, err: msg },
      "driveResume: unresumable agent session — crashing",
    );
    await crashRunningRun(runId, "agent-session-gone", { db });

    return { state: "unresumable" };
  }
}
