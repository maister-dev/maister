import "server-only";

import type { ExecutionAssignment } from "@/lib/db/schema";
import type { CreateSessionInput } from "@/lib/execution-host";
import type { ExecutionHosts } from "@/lib/execution-host";

import { and, count, eq, inArray, isNull, notInArray } from "drizzle-orm";
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
import { loadConsensusRecoveryEvidence } from "@/lib/flows/graph/consensus/recovery-evidence";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import {
  applyCrashedTurnEvidence,
  clearCrashRecoverMarker,
  closeCrashedNodeAttempts,
  resolveNodeResumeSessionId,
  CRASH_RECOVER_BUDGET_RESET,
} from "@/lib/runs/crash-recover";
import { crashRunningRun } from "@/lib/runs/state-transitions";
import { SETTLED_RUN_STATUSES } from "@/lib/runs/run-status-sets";
import {
  maxConcurrentRunsCap,
  releaseSlotOnIdle,
  takeSchedulerLock,
} from "@/lib/scheduler";
import {
  createExecutionHosts,
  isFencedError,
  localHost,
  mintPlacement,
} from "@/lib/execution-host";

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
  // ADR-175: `runStatus` is the run's COMMITTED status, not a constant derived
  // from the outcome. A coordinator handed back to its child-wait gate really
  // is `WaitingOnChildren`, and saying `Running` would publish a status the run
  // does not have. Absent ⇒ the ordinary `Running`.
  | { state: "resumed"; runStatus?: string }
  | { state: "redispatched" }
  | { state: "queued" }
  | { state: "discard-only" }
  | { state: "workspace-removed" }
  | { state: "conflict" }
  | { state: "unresumable" }
  | { state: "transient" };

// Crash-recover signal threaded into runFlow so the runner resumes FROM the
// crashed node (re-runs it once) instead of no-op'ing or restarting from entry.
// ADR-175: both recover arms now take this door, so the handle and the minted
// assignment travel with it — without `db`/`executionHosts` the runner binds a
// fresh local host over `getDb()` instead of the caller's.
export type RunFlowResumeOpts = {
  crashResume?: { targetStepId: string };
  orchestratorResume?: { targetStepId: string };
  db?: Db;
  executionHosts?: ExecutionHosts;
};

export interface ResumeCrashedRunOptions {
  db?: Db;
  executionHosts?: ExecutionHosts;
  runFlow?: (id: string, runOpts?: RunFlowResumeOpts) => Promise<void> | void;
  now?: () => Date;
}

export interface DriveResumeOptions extends ResumeCrashedRunOptions {
  // ADR-166: the `recover` generation the claim minted. Absent when the
  // scheduler re-enters a queued recover standalone — the pointer that claim
  // left on the run is read at entry instead.
  assignmentId?: string | null;
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
  const cap = maxConcurrentRunsCap();
  const hosts = opts.executionHosts ?? createExecutionHosts({ db });

  // ADR-166 D3: a recover is a new driver generation — its epoch is minted
  // inside the Crashed → Running|Pending claim below. Resolve the host first
  // so an unavailable host refuses the recover as transient with no claim.
  let placementHost;

  try {
    placementHost = await localHost({ db, transport: hosts.transport });
  } catch (err) {
    log.warn(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "resumeCrashedRun: local execution host unavailable — transient",
    );

    return { state: "transient" };
  }

  // Phase-1 commit outcome: either a terminal RecoverResult (no side-effect
  // needed) or the `drive` marker meaning the slot-free Crashed→Running flip
  // committed and Phase 2 must run.
  type Phase1 =
    | RecoverResult
    | { state: "drive"; assignment: ExecutionAssignment };

  const phase1: Phase1 = await db.transaction(async (tx: Db) => {
    await takeSchedulerLock(tx);

    const rows = await tx
      .select({
        id: runs.id,
        status: runs.status,
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

    const workspaceRows = await tx
      .select({ removedAt: workspaces.removedAt })
      .from(workspaces)
      .where(eq(workspaces.runId, runId))
      .limit(1);

    if (workspaceRows[0]?.removedAt != null) {
      log.info({ runId }, "resumeCrashedRun: workspace was removed");

      return { state: "workspace-removed" };
    }

    // The recover target is the node id retained at crash time
    // (resume_target_step_id; current_step_id is nulled on a clean crash),
    // falling back to current_step_id for live/hand-seeded rows.
    const resumeTarget = run.resumeTargetStepId ?? run.currentStepId;
    const { nodeKind, retrySafe, sessionName } = await resolveNodeRecoverInfo(
      tx,
      {
        flowRevisionId: run.flowRevisionId,
        flowId: run.flowId,
        stepId: resumeTarget,
      },
    );
    // ADR-175: NODE-scoped, not `loadActiveRunSession`. For a crashed run every
    // incarnation is terminal, so that ranking's liveness key ties false and a
    // finished substep session wins on `updated_at`.
    const acpSessionId = await resolveNodeResumeSessionId(tx, {
      runId,
      nodeId: resumeTarget,
      sessionName,
    });
    const consensusEvidence =
      nodeKind === "consensus"
        ? await loadConsensusRecoveryEvidence(tx, {
            runId,
            nodeId: resumeTarget,
          })
        : undefined;
    const plan = classifyRecover(
      { acpSessionId },
      nodeKind,
      retrySafe,
      consensusEvidence,
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
          // Studio AI assistant runs hold the separate assistant budget — keep
          // them out of the flow recover cap (sibling of the two scheduler
          // counters that already exclude local_package_id).
          isNull(runs.localPackageId),
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
          // ADR-176 D4: the budget is INTENT-scoped and is reset in the same
          // transaction that stamps the marker. Resetting here rather than at
          // the five release sites is what makes a fresh intent always start
          // from zero — two of those sites are reparks, which would otherwise
          // strand a count into an unrelated future intent.
          ...CRASH_RECOVER_BUDGET_RESET,
        })
        .where(and(eq(runs.id, runId), eq(runs.status, "Crashed")))
        .returning({ id: runs.id });

      if (updated.length === 0) return { state: "conflict" };

      await mintPlacement(tx, {
        runId,
        reason: "recover",
        host: placementHost,
      });
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
        // ADR-176 D4: see the queued arm above — reset at the WRITE site.
        ...CRASH_RECOVER_BUDGET_RESET,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "Crashed")))
      .returning({ id: runs.id });

    if (updated.length === 0) return { state: "conflict" };

    const assignment = await mintPlacement(tx, {
      runId,
      reason: "recover",
      host: placementHost,
    });

    log.info(
      { runId, liveCount, cap },
      "resumeCrashedRun: slot free → Running",
    );

    return { state: "drive", assignment };
  });

  // Terminal Phase-1 outcomes (no side-effect required).
  if (phase1.state !== "drive") {
    return phase1;
  }

  // Slot-free path: drive the Phase-2 side-effect against the already-Running run.
  return await driveResume(runId, {
    ...opts,
    assignmentId: phase1.assignment.id,
  });
}

// Phase 2 side-effect: the run is already Running (durable marker committed).
// ADR-175: BOTH arms re-enter the flow graph. The agent arm used to create a
// session and hand it to the NeedsInput permission driver, which has no durable
// continuation to resume for a crashed run — so it prompted directly and
// `admitNodePrompt` refused it (`node_admission_generation`), because the
// crashed attempt is still bound to the retired assignment epoch. The driver
// swallowed that refusal as a yield and left the run `Running` with an idle
// session nobody drove.
//
// Safe to call standalone on an already-Running run — it is also the
// scheduler's resume callback for a queued recover.
export async function driveResume(
  runId: string,
  opts: DriveResumeOptions = {},
): Promise<{
  state: "resumed" | "redispatched" | "unresumable" | "transient";
  runStatus?: string;
}> {
  const db = opts.db ?? getDb();
  const hosts = opts.executionHosts ?? createExecutionHosts({ db });
  const runFlowFn =
    opts.runFlow ??
    (async (id: string, runOpts?: RunFlowResumeOpts) => {
      const mod = await import("@/lib/flows/runner");

      await mod.runFlow(id, runOpts);
    });

  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      runKind: runs.runKind,
      currentStepId: runs.currentStepId,
      resumeTargetStepId: runs.resumeTargetStepId,
      projectId: runs.projectId,
      flowId: runs.flowId,
      flowRevisionId: runs.flowRevisionId,
      executionAssignmentId: runs.executionAssignmentId,
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

  // ADR-175 / skill-context: a SHARED dispatch branches on `run_kind` BEFORE it
  // routes. Scratch and standalone-agent runs have their own recovery owners
  // (`scratch-runs/recovery.ts`, the agent session observer) and must never
  // enter the flow-only crash-resume arm below.
  if (run.runKind !== "flow") {
    log.warn(
      { runId, runKind: run.runKind },
      "driveResume: refusing a non-flow run — its own recovery owner drives it",
    );

    return { state: "unresumable" };
  }

  // Phase-1 set current_step_id to the recover target; fall back to the retained
  // marker if driveResume is entered standalone.
  const resumeTarget = run.currentStepId ?? run.resumeTargetStepId;
  const { nodeKind, retrySafe, sessionName } = await resolveNodeRecoverInfo(
    db,
    {
      flowRevisionId: run.flowRevisionId,
      flowId: run.flowId,
      stepId: resumeTarget,
    },
  );
  const acpSessionId = await resolveNodeResumeSessionId(db, {
    runId,
    nodeId: resumeTarget,
    sessionName,
  });
  const consensusEvidence =
    nodeKind === "consensus"
      ? await loadConsensusRecoveryEvidence(db, {
          runId,
          nodeId: resumeTarget,
        })
      : undefined;
  const plan = classifyRecover(
    { acpSessionId },
    nodeKind,
    retrySafe,
    consensusEvidence,
  );

  log.info(
    {
      runId,
      nodeKind,
      plan,
      retrySafe,
      acpSessionIdPresent: Boolean(acpSessionId),
    },
    "driveResume: classified",
  );

  // The `recover` generation the claim minted, or — entered standalone by the
  // scheduler after a queued recover promoted — the pointer that claim left on
  // the run. NULL = a never-placed legacy run (placed lazily as `recover`).
  const assignmentId = opts.assignmentId ?? run.executionAssignmentId ?? null;

  if (plan === "redispatch") {
    // Explicit crash-recover signal: the runner resumes FROM this node (re-runs
    // it once) instead of no-op'ing on the already-owned graph guard.
    await runFlowFn(runId, {
      ...(resumeTarget ? { crashResume: { targetStepId: resumeTarget } } : {}),
      db,
      executionHosts: hosts,
    });
    log.info(
      { runId, targetStepId: resumeTarget },
      "driveResume: session-less retry_safe node -> redispatched (resume from node)",
    );

    return { state: "redispatched" };
  }

  // `classifyRecover` has THREE outcomes and this dispatch is entered
  // standalone — by the scheduler's queued promotion and by the reconcile
  // sweep's crash-recover arm, neither of which re-runs Phase 1's refusal. A
  // target with no resumable handle must therefore refuse HERE too, or the
  // sweep silently dispatches a fresh session for a node `POST /recover`
  // answers `409 discard-only` on.
  if (plan === "discard-only") {
    log.warn(
      { runId, nodeKind, retrySafe, targetStepId: resumeTarget },
      "driveResume: no resumable target — discard-only",
    );
    await crashRunningRun(runId, "agent-session-gone", { db });

    return { state: "unresumable" };
  }

  // resume-agent: re-enter the graph at the recover target.
  const launch = recoveredRunLaunchInput({
    runnerSnapshot:
      (await loadActiveRunSession(db, runId))?.runnerSnapshot ?? null,
  });

  if (!launch) {
    log.error({ runId }, "driveResume: no runner snapshot or legacy executor");
    await crashRunningRun(runId, "agent-session-gone", { db });

    return { state: "unresumable" };
  }

  if (!resumeTarget || !assignmentId) {
    log.error(
      { runId, resumeTarget, assignmentId },
      "driveResume: agent recover without a target node or placement",
    );
    await crashRunningRun(runId, "agent-session-gone", { db });

    return { state: "unresumable" };
  }

  try {
    if (nodeKind === "orchestrator") {
      const arm = await driveOrchestratorRecover(runId, {
        db,
        hosts,
        runFlowFn,
        targetStepId: resumeTarget,
      });

      if (arm) return arm;
    }

    // ADR-175 Scope 2. Evidence BEFORE dispatch: a turn the host already
    // finished is applied, never bought twice. Host I/O, so it runs outside
    // every transaction.
    const evidence = await applyCrashedTurnEvidence(db, {
      runId,
      nodeId: resumeTarget,
      assignmentId,
    });

    if (evidence === "quarantined") {
      // A disagreeing turn is an impasse for an operator, NEVER a re-prompt.
      await crashRunningRun(runId, "agent-session-gone", { db });

      return { state: "unresumable" };
    }
    if (evidence === "applied") {
      // The applied attempt carries its own completion and is re-bound to this
      // epoch, so the ordinary durable continuation finishes the visit. No
      // crash-resume signal: that would append a fresh attempt and re-prompt.
      await runFlowFn(runId, { db, executionHosts: hosts });
      // This arm re-enters WITHOUT `crashResume`, so `runGraph`'s CAS-clear
      // never fires and the intent marker would outlive the recover that
      // consumed it. Best-effort like the sibling `releaseSlotOnIdle` below:
      // the graph continuation has ALREADY run, so letting this throw into the
      // catch would crash a run that just succeeded. A missed clear costs one
      // redundant sweep re-entry; a wrong crash costs the turn.
      await clearCrashRecoverMarker(db, runId).catch((error: unknown) => {
        log.warn(
          { runId, code: isMaisterError(error) ? error.code : "UNKNOWN" },
          "driveResume: could not release the recover intent marker",
        );
      });
      log.info(
        { runId, targetStepId: resumeTarget, assignmentId },
        "driveResume: agent arm -> evidence applied, graph continued without a new prompt",
      );

      return { state: "resumed" };
    }

    // ADR-177: `"turn-lost"` falls through to exactly this path, and that is
    // deliberate rather than an omission. The host lost the turn, so there is
    // nothing to apply and nothing to quarantine — the run needs one fresh
    // prompt, which is what `"absent"` already means here. The declined
    // command was discharged `superseded` inside the evidence call, so it does
    // not strand once this attempt closes.
    //
    // ADR-175 Scope 1. Close the attempt the crash left open, so the graph
    // appends a FRESH one under this epoch and admission passes by
    // construction. Its own transaction, after the evidence decision and before
    // the dispatch — both crash windows that creates are re-entered
    // idempotently through the same `crashResume` claim.
    const closedAttemptIds = await closeCrashedNodeAttempts(db, {
      runId,
      nodeId: resumeTarget,
    });

    if (closedAttemptIds.length === 0)
      log.warn(
        { runId, targetStepId: resumeTarget },
        "driveResume: no open attempt to close — legitimate after terminal evidence applied",
      );
    else
      log.info(
        { runId, targetStepId: resumeTarget, assignmentId, closedAttemptIds },
        "driveResume: crash-recover intent committed",
      );

    log.info(
      {
        runId,
        targetStepId: resumeTarget,
        nodeKind,
        resumeSessionIdPresent: Boolean(acpSessionId),
      },
      "driveResume: agent arm -> graph re-entry",
    );
    await runFlowFn(runId, {
      crashResume: { targetStepId: resumeTarget },
      db,
      executionHosts: hosts,
    });

    return { state: "resumed" };
  } catch (err) {
    // ADR-166 yield rule: a newer generation owns the run — write nothing.
    if (isFencedError(err)) {
      log.warn({ runId }, "driveResume: driver-yielded — assignment fenced");

      return { state: "transient" };
    }
    // Transient (supervisor 5xx / network) → leave Running, NO rollback; an
    // operator/sweeper can retry, and the reconcile sweep re-enters the
    // committed intent through the same claim.
    if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
      log.warn(
        { runId, err: err.message },
        "driveResume: transient supervisor failure — leaving Running",
      );

      return { state: "transient" };
    }

    // Anything else → the dispatch failed unrecoverably. Crash the Running run
    // (clears resume_started_at) so the row is cleanly terminal. A supervisor
    // that merely refuses the retained resume handle is NOT this case: the
    // graph degrades to a fresh session with `session_fallback` (ADR-081).
    const msg = err instanceof Error ? err.message : String(err);

    log.warn(
      { runId, err: msg },
      "driveResume: unresumable crash recover — crashing",
    );
    await crashRunningRun(runId, "agent-session-gone", { db });

    return { state: "unresumable" };
  }
}

// ADR-175 Scope 7 / T2.7. A run can crash FROM `WaitingOnChildren`, and the
// classifier routes `orchestrator` to the agent plan regardless. Recovering a
// waiting coordinator by PROMPTING it re-delegates children that may still be
// running, so the child state decides the arm. Returns null when the ordinary
// crash-resume path applies (no children were ever created).
async function driveOrchestratorRecover(
  runId: string,
  ctx: {
    db: Db;
    hosts: ExecutionHosts;
    runFlowFn: (
      id: string,
      runOpts?: RunFlowResumeOpts,
    ) => Promise<void> | void;
    targetStepId: string;
  },
): Promise<{ state: "resumed"; runStatus?: string } | null> {
  const { db, hosts, runFlowFn, targetStepId } = ctx;
  const totals: Array<{ n: number }> = await db
    .select({ n: count() })
    .from(runs)
    .where(eq(runs.parentRunId, runId));
  const childrenTotal = Number(totals[0]?.n ?? 0);

  if (childrenTotal === 0) return null;

  // The SAME settled predicate the three existing child counters use — a
  // fourth copy is how they drift apart.
  const unsettledRows: Array<{ n: number }> = await db
    .select({ n: count() })
    .from(runs)
    .where(
      and(
        eq(runs.parentRunId, runId),
        notInArray(runs.status, [...SETTLED_RUN_STATUSES]),
      ),
    );
  const childrenUnsettled = Number(unsettledRows[0]?.n ?? 0);

  if (childrenUnsettled > 0) {
    // Park back onto the EXISTING wait gate and let the child-terminal wake
    // path drive it, exactly as a never-crashed coordinator is driven.
    // `markWaitingOnChildren` is deliberately NOT used: it is dead in
    // production and writes `checkpoint_at`/`keepalive_until`, which the live
    // park does not. `resume_requested_at` MUST be cleared — `crashWaitingOnChildren`
    // leaves it, so a capacity-deferred coordinator would carry a stale stamp
    // back and the continuation worker would immediately try to re-wake it.
    await db.transaction(async (tx: Db) => {
      await tx
        .update(runs)
        .set({
          status: "WaitingOnChildren",
          currentStepId: targetStepId,
          resumeStartedAt: null,
          resumeRequestedAt: null,
        })
        .where(and(eq(runs.id, runId), eq(runs.status, "Running")));
    });
    // `WaitingOnChildren` is excluded from `countLiveRuns`, so parking back
    // frees the slot on its own — nothing leaks. What is lost without this call
    // is the PROMOTION opportunity: a queued `Pending` run would wait for an
    // unrelated trigger. Non-transactional and best-effort, like the live park.
    await releaseSlotOnIdle({ runId, db }).catch((error: unknown) => {
      log.warn(
        {
          runId,
          code: isMaisterError(error) ? error.code : "UNKNOWN",
        },
        "driveResume: coordinator park — slot promotion failed",
      );
    });
    log.info(
      { runId, childrenTotal, childrenUnsettled, arm: "wait" },
      "driveResume: orchestrator arm",
    );

    return { state: "resumed", runStatus: "WaitingOnChildren" };
  }

  // All children settled: re-enter through the EXISTING orchestrator-resume
  // mode, which reuses the parked `NeedsInput` attempt and threads the
  // coordinator's own handle. Never `crashResume` — `isOrchestratorResume`
  // requires `!isCrashResume`, so passing both silently takes the crash path,
  // appends a fresh attempt and re-delegates.
  log.info(
    { runId, childrenTotal, childrenUnsettled: 0, arm: "resume" },
    "driveResume: orchestrator arm",
  );
  await runFlowFn(runId, {
    orchestratorResume: { targetStepId },
    db,
    executionHosts: hosts,
  });
  // `isOrchestratorResume` requires `!isCrashResume`, so the graph's CAS-clear
  // is unreachable on this arm by construction — release the claim here.
  // Best-effort for the same reason as the evidence arm: the re-entry already
  // happened, so this must not be able to turn a success into a crash.
  await clearCrashRecoverMarker(db, runId).catch((error: unknown) => {
    log.warn(
      { runId, code: isMaisterError(error) ? error.code : "UNKNOWN" },
      "driveResume: could not release the recover intent marker",
    );
  });

  return { state: "resumed" };
}
