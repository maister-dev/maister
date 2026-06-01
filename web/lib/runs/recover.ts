import "server-only";

import type { RunResumedSessionOptions } from "@/lib/runs/resume-driver";
import type {
  CreateSessionInput,
  SupervisorExecutorInput,
} from "@/lib/supervisor-client";

import { and, count, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { resolveCurrentNodeKind } from "@/lib/flows/graph/current-node-kind";
import { scheduleResumedSessionDrive } from "@/lib/runs/resume-driver";
import { crashRunningRun } from "@/lib/runs/state-transitions";
import { takeSchedulerLock } from "@/lib/scheduler";
import { createSession } from "@/lib/supervisor-client";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { executors, projects, runs, workspaces } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "run-recover",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_CAP = 3;

// Mirror scheduler's capFromEnv() — kept local so recover is self-contained.
function capFromEnv(): number {
  const raw = process.env.MAISTER_MAX_CONCURRENT_RUNS;

  if (!raw) return DEFAULT_CAP;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CAP;

  return parsed;
}

type NodeKind =
  | "ai_coding"
  | "cli"
  | "check"
  | "judge"
  | "guard"
  | "human"
  | null;

// --- T3.1: pure classifier ------------------------------------------------

export type RecoverPlan = "resume-agent" | "redispatch" | "discard-only";

// The recovery-plan analogue of classifyRunReconcile. PURE (no clock/db):
//   - ai_coding + acpSessionId present -> "resume-agent"
//   - ai_coding + acpSessionId null    -> "discard-only"
//   - any other node kind              -> "redispatch"
export function classifyRecover(
  run: { acpSessionId: string | null },
  currentNodeKind: NodeKind,
): RecoverPlan {
  if (currentNodeKind === "ai_coding") {
    return run.acpSessionId ? "resume-agent" : "discard-only";
  }

  return "redispatch";
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

export interface ResumeCrashedRunOptions {
  db?: Db;
  createSession?: typeof createSession;
  scheduleResumedSessionDrive?: (o: RunResumedSessionOptions) => string;
  runFlow?: (id: string) => Promise<void> | void;
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

    const kind = await resolveCurrentNodeKind(tx, {
      flowRevisionId: run.flowRevisionId,
      flowId: run.flowId,
      currentStepId: run.currentStepId,
    });
    const plan = classifyRecover({ acpSessionId: run.acpSessionId }, kind);

    if (plan === "discard-only") {
      log.info(
        { runId },
        "resumeCrashedRun: agent node with no acpSessionId — discard-only",
      );

      return { state: "discard-only" };
    }

    const liveRows: Array<{ count: number }> = await tx
      .select({ count: count() })
      .from(runs)
      .where(inArray(runs.status, ["Running", "NeedsInput", "HumanWorking"]));
    const liveCount = Number(liveRows[0]?.count ?? 0);
    const resumeTarget = run.currentStepId;
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
      executorId: runs.executorId,
      projectId: runs.projectId,
      flowId: runs.flowId,
      flowRevisionId: runs.flowRevisionId,
      worktreePath: workspaces.worktreePath,
      projectSlug: projects.slug,
      agent: executors.agent,
      model: executors.model,
      env: executors.env,
      router: executors.router,
    })
    .from(runs)
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .innerJoin(projects, eq(projects.id, runs.projectId))
    .innerJoin(executors, eq(executors.id, runs.executorId))
    .where(eq(runs.id, runId));
  const run = rows[0];

  if (!run) {
    log.error({ runId }, "driveResume: run row vanished after flip");

    return { state: "unresumable" };
  }

  const kind = await resolveCurrentNodeKind(db, {
    flowRevisionId: run.flowRevisionId,
    flowId: run.flowId,
    currentStepId: run.currentStepId,
  });
  const plan = classifyRecover({ acpSessionId: run.acpSessionId }, kind);

  if (plan === "redispatch") {
    const runFlowFn =
      opts.runFlow ??
      (async (id: string) => {
        const mod = await import("@/lib/flows/runner");

        await mod.runFlow(id);
      });

    await runFlowFn(runId);
    log.info({ runId }, "driveResume: session-less gate node → redispatched");

    return { state: "redispatched" };
  }

  // resume-agent: re-issue the prior session via --resume <acpSessionId>.
  const executor: SupervisorExecutorInput = {
    agent: run.agent,
    model: run.model,
    ...(run.env ? { env: run.env } : {}),
    ...(run.router ? { router: run.router } : {}),
  };
  const stepId = run.currentStepId ?? "resume";

  try {
    const input: CreateSessionInput = {
      runId,
      projectSlug: run.projectSlug,
      worktreePath: run.worktreePath,
      stepId,
      executor,
      resumeSessionId: run.acpSessionId ?? undefined,
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
