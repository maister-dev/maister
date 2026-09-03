import "server-only";

import type { ExecutionHost } from "@/lib/db/schema";
import type {
  ExecutionHostTransport,
  PlacementReason,
} from "@/lib/execution-host";

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import pino from "pino";

import { nextKeepaliveAt } from "./keepalive-config";

import { RELEASED_LIFECYCLE_CLAIM } from "@/lib/runs/lifecycle-claim";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { RUN_SYNC_TERMINAL_PHASES } from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { type RunReviewCause } from "@/lib/domain-events/taxonomy";
import { emitDelegatedReviewIfChild } from "@/lib/runs/delegated-review-emit";
import { mintPlacement, releaseAssignmentForRun } from "@/lib/execution-host";
import { gcAgeDays } from "@/lib/instance-config";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, workspaces, runSyncAttempts } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "run-state",
  level: process.env.LOG_LEVEL ?? "info",
});

export type StateTransitionResult =
  | { ok: true }
  | { ok: false; reason: "status-guard-mismatch" | "not-found" };

// ADR-141: a run that terminalizes MUST NOT strand a live branch-sync claim.
// `run_sync_attempts` and the workspace lifecycle slot outlive `runs.status`, and
// every sync recovery arm keys on a NON-terminal run — so a claim still held at
// crash time is invisible to all of them and refuses promotion (and all six other
// lifecycle ops) forever, with no exit but hand-written SQL. Runs in the SAME
// transaction as the terminal flip, so the pair can never half-apply.
//
// `name='sync'` is a sufficient guard HERE (unlike in the recovery sweeps, which
// must fence on the claim token): this runs inside the tx that just terminalized
// the run's attempts, and — now that the claim tx re-validates the run as `Review`
// under its own row lock — a sync can only ever be claimed by a
// `Review` run — so no newer sync can hold this slot.
async function releaseSyncClaimOnTerminal(
  tx: Db,
  runId: string,
  errorCode: string,
): Promise<void> {
  const attempts = await tx
    .update(runSyncAttempts)
    .set({
      phase: "failed",
      errorCode,
      errorMessage: "run terminalized while a branch sync was in flight",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runSyncAttempts.runId, runId),
        notInArray(
          runSyncAttempts.phase,
          RUN_SYNC_TERMINAL_PHASES as unknown as string[],
        ),
      ),
    )
    .returning({
      id: runSyncAttempts.id,
      workspaceId: runSyncAttempts.workspaceId,
    });

  // Terminalizing an attempt and freeing the slot are SEPARATE facts, and this used
  // to return early when no attempt was still non-terminal — on the assumption that
  // "no active attempt" implies "no claim held". It does not: a sync that wrote its
  // terminal phase and then died before releasing leaves exactly that shape, and it
  // is the one shape no recovery arm can see (they all filter to non-terminal
  // attempts). This is one of only three writers that reset the slot, so gating it
  // on the attempt write made the strand permanent for sync.
  //
  // The release is therefore driven by the WORKSPACE's own sync claim, not by
  // whether we won the attempt write. `name='sync'` remains a sufficient fence: the
  // claim tx now re-validates the run as `Review` under its row lock, so no newer
  // sync can hold this slot behind a run we are terminalizing right here.
  const released = await tx
    .update(workspaces)
    .set(RELEASED_LIFECYCLE_CLAIM)
    .where(
      and(
        eq(workspaces.runId, runId),
        eq(workspaces.lifecycleOperationName, "sync"),
      ),
    )
    .returning({ workspaceId: workspaces.id });

  if (attempts.length === 0 && released.length === 0) return;

  log.warn(
    {
      runId,
      // Was logging `workspaceId` under the key `attemptId` — wrong value, wrong
      // name, on the one line that reports this repair.
      attemptId: attempts[0]?.id ?? null,
      workspaceId: released[0]?.workspaceId ?? attempts[0]?.workspaceId ?? null,
      terminalizedAttempt: attempts.length > 0,
      releasedClaim: released.length > 0,
    },
    "released a branch-sync claim stranded by a terminal run",
  );
}

export type StateTransitionOptions = {
  db?: Db;
  recordSuccessAudit?: (db: Db) => Promise<void>;
  // ADR-164 D3: a claim transition that starts a new driver generation mints
  // its epoch inside the CAS tx. A caller that already resolved the local host
  // (launch-style) passes it; otherwise the memoized local host resolves here.
  placement?: {
    host?: ExecutionHost;
    transport?: ExecutionHostTransport;
    // A claim site that is not the plain re-entry names its own reason (the
    // gate-chat idle resume mints `gate_chat`).
    reason?: PlacementReason;
  };
};

async function mintForClaim(
  tx: Db,
  runId: string,
  reason: PlacementReason,
  opts: StateTransitionOptions,
): Promise<void> {
  await mintPlacement(tx, {
    runId,
    reason: opts.placement?.reason ?? reason,
    host: opts.placement?.host,
    transport: opts.placement?.transport,
  });
}

// NeedsInput → NeedsInputIdle CAS + the ADR-164 assignment release in ONE tx:
// the checkpoint ends this driver incarnation (the resume mints the next epoch).
async function idleFromNeedsInput(db: Db, runId: string): Promise<boolean> {
  return db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({
        status: "NeedsInputIdle",
        checkpointAt: new Date(),
        keepaliveUntil: null,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
      .returning({ id: runs.id });

    if (rows.length === 0) return false;

    await releaseAssignmentForRun(tx, runId, "checkpointed");

    return true;
  });
}

// M8 D3 / D5: NeedsInput → NeedsInputIdle on keep-alive expiry. The
// sweeper calls this AFTER the supervisor has acknowledged the graceful
// checkpoint (or after the supervisor was found to be no longer holding
// the session). Atomicity guarantee: the UPDATE WHERE-clause is a
// status guard — if the row moved to Running/Crashed/Failed/etc. in the
// meantime (e.g. operator manually resumed via /respond before the
// sweeper tick fired), the UPDATE is a no-op and we return
// `{ok: false, reason: "status-guard-mismatch"}`.
export async function markCheckpointed(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const idled = await idleFromNeedsInput(db, runId);

  if (!idled) {
    log.warn(
      { runId, from: "NeedsInput", to: "NeedsInputIdle" },
      "markCheckpointed: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "NeedsInput", to: "NeedsInputIdle" },
    "run-state transition",
  );

  return { ok: true };
}

// M8 Codex review fix #1: same NeedsInput → NeedsInputIdle as
// markCheckpointed, but called from the runner-agent's event consumer
// when it observes `session.exited.reason === "checkpoint"` on the SSE
// stream (rather than from the keep-alive sweeper). The SQL is identical
// — only the log message differs so the trigger is auditable. Idempotent
// with the sweeper path because both share the status guard.
export async function markCheckpointedFromExit(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const idled = await idleFromNeedsInput(db, runId);

  if (!idled) {
    log.warn(
      { runId, from: "NeedsInput", to: "NeedsInputIdle", trigger: "exit" },
      "markCheckpointedFromExit: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "NeedsInput", to: "NeedsInputIdle", trigger: "exit" },
    "run-state transition — runner-agent observed checkpoint reason",
  );

  return { ok: true };
}

// M8 D7 (success path) / D8 Phase 2: NeedsInputIdle → NeedsInput on
// resume. Sets a fresh `keepalive_until` so the resumed run cannot be
// re-checkpointed by the next sweeper tick before the operator has even
// finished interacting. Clears `checkpoint_at` so the run looks like a
// fresh live session for diagnostics.
export async function markResumed(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();

  return await (db as { transaction: any }).transaction(
    async (tx: Db): Promise<StateTransitionResult> => {
      const rows = await tx
        .update(runs)
        .set({
          status: "NeedsInput",
          keepaliveUntil: nextKeepaliveAt(),
          checkpointAt: null,
        })
        .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInputIdle")))
        .returning({ id: runs.id });

      if (rows.length === 0) {
        log.warn(
          { runId, from: "NeedsInputIdle", to: "NeedsInput" },
          "markResumed: status-guard mismatch",
        );

        return { ok: false, reason: "status-guard-mismatch" };
      }

      // The resume is a new driver generation: mint inside the claim.
      await mintForClaim(tx, runId, "resume", opts);
      await opts.recordSuccessAudit?.(tx);

      log.info(
        { runId, from: "NeedsInputIdle", to: "NeedsInput" },
        "run-state transition",
      );

      return { ok: true };
    },
  );
}

// M37 (ADR-098): Running → WaitingOnChildren. The orchestrator node yields
// awaiting its delegated children; the run is checkpointed (the agent process
// is SIGTERMed, acp_session_id retained) and the caller releases its agent-pool
// slot so a parked coordinator never starves the cap. Status-guarded: a
// concurrent terminal/crash that moved the row off Running wins → no-op → 409.
export async function markWaitingOnChildren(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({
      status: "WaitingOnChildren",
      checkpointAt: new Date(),
      keepaliveUntil: null,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.warn(
      { runId, from: "Running", to: "WaitingOnChildren" },
      "markWaitingOnChildren: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  // ADR-164 D2: a parked coordinator has no driver — its assignment ends here
  // and the wait-resume re-entry mints the next epoch.
  await releaseAssignmentForRun(db, runId, "waiting_on_children");

  log.info(
    { runId, from: "Running", to: "WaitingOnChildren" },
    "run-state transition",
  );

  return { ok: true };
}

// M37 (ADR-098): WaitingOnChildren → Running. A child-terminal domain event (or
// a manual resume) wakes the parked orchestrator; the supervisor respawns +
// session/resume restores context. Status-guarded so a concurrent event-resume
// + manual-resume converge to a single winner (the loser → 409); clears
// checkpoint_at so the resumed run reads as a fresh live session.
export async function markResumedFromWait(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();

  return await (db as { transaction: any }).transaction(
    async (tx: Db): Promise<StateTransitionResult> => {
      const rows = await tx
        .update(runs)
        .set({ status: "Running", checkpointAt: null })
        .where(and(eq(runs.id, runId), eq(runs.status, "WaitingOnChildren")))
        .returning({ id: runs.id });

      if (rows.length === 0) {
        log.warn(
          { runId, from: "WaitingOnChildren", to: "Running" },
          "markResumedFromWait: status-guard mismatch",
        );

        return { ok: false, reason: "status-guard-mismatch" };
      }

      // The woken coordinator is a new driver generation (ADR-164 D3).
      await mintForClaim(tx, runId, "wait_resume", opts);
      await opts.recordSuccessAudit?.(tx);

      log.info(
        { runId, from: "WaitingOnChildren", to: "Running" },
        "run-state transition",
      );

      return { ok: true };
    },
  );
}

// M37 (ADR-098) T5.2: Running → WaitingOnChildren rollback. After the resume
// consumer wins markResumedFromWait but the re-drive's session respawn fails
// RETRYABLY (supervisor 5xx / EXECUTOR_UNAVAILABLE), flip the run back to the
// parked state so a LATER child-terminal event can retry the wake. Status-guarded
// on Running so a run that the re-drive already advanced (re-parked, terminal, or
// concurrently resumed) is never clobbered → {ok:false}. Re-stamps checkpoint_at
// so the row reads as parked again.
export async function rollbackResumeFromWait(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rolledBack: boolean = await db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({
        status: "WaitingOnChildren",
        checkpointAt: new Date(),
        keepaliveUntil: null,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
      .returning({ id: runs.id });

    if (rows.length === 0) return false;

    // ADR-164: the generation minted by the wait-resume claim never drove.
    await releaseAssignmentForRun(tx, runId, "wait_resume_rollback");

    return true;
  });

  if (!rolledBack) {
    log.warn(
      { runId, from: "Running", to: "WaitingOnChildren (rollback)" },
      "rollbackResumeFromWait: status-guard mismatch — concurrent transition won",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "Running", to: "WaitingOnChildren (rollback)" },
    "run-state transition — resume rolled back after retryable respawn failure",
  );

  return { ok: true };
}

// M37 (ADR-100): Review → Running. `run_rework` re-opens a DELEGATED child whose
// turn produced a diff (Review) for another turn against its intact worktree.
// Status-guarded on Review so a concurrent promote (Review → Done) or a duplicate
// rework converges to ONE winner (loser → CONFLICT). Deliberately does NOT null
// `acp_session_id` (preserved on the delegated Review flip) so startAgentSession
// resumes with prior context; clears keepalive. The consume loop re-reviews on
// the next end_turn.
export async function markReworkFromReview(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({ status: "Running", checkpointAt: null, keepaliveUntil: null })
    .where(and(eq(runs.id, runId), eq(runs.status, "Review")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.warn(
      { runId, from: "Review", to: "Running" },
      "markReworkFromReview: status-guard mismatch — concurrent promote/rework won",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "Review", to: "Running" },
    "run-state transition — child re-opened for rework",
  );

  return { ok: true };
}

// ADR-141: Review → Running. The branch-sync AI resolver opens a Review run for
// a conflicted rebase/merge. Bare status-guarded CAS (mirrors
// markReworkFromReview): a concurrent promote (Review → Done) or another sync
// converges to ONE winner (loser → CONFLICT at the caller). Touches NO runs
// session column (M42 dropped it); the caller wraps this in the FOR-UPDATE
// promotion fence + cap gate. Clears keepalive/checkpoint so the run reads live.
// ADR-160: the rework claim's status CAS. Exact-allow-list `WHERE
// status='Review'` — a set CAS would silently permit within-set transitions.
// This runs FIRST inside the claim transaction so a concurrent loser is refused
// here and never reaches the UNIQUE(run_id, node_id, attempt) insert.
export async function markReworkClaimFromReview(
  runId: string,
  userId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({ status: "HumanWorking" })
    .where(and(eq(runs.id, runId), eq(runs.status, "Review")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.warn(
      { runId, userId, from: "Review", to: "HumanWorking" },
      "markReworkClaimFromReview: status-guard mismatch — concurrent claim/promote/sync won",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, userId, from: "Review", to: "HumanWorking" },
    "run-state transition — rework claim taken from Review",
  );

  return { ok: true };
}

// The Review re-entries below share one shape: an exact-status CAS onto
// `Review` plus the delegated-child `run.review` domain emit in the SAME
// transaction (ADR-163 — a Review a settled-event consumer waits on that
// nothing emits is a deadlock). `opts.db` may already be a transaction; the
// nested call becomes a savepoint.
async function casToReviewAndEmit(
  db: Db,
  runId: string,
  set: Record<string, unknown>,
  fromStatus: string,
  cause: RunReviewCause,
): Promise<{ id: string }[]> {
  return db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set(set)
      .where(and(eq(runs.id, runId), eq(runs.status, fromStatus)))
      .returning({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        flowId: runs.flowId,
        runKind: runs.runKind,
        parentRunId: runs.parentRunId,
      });

    if (rows.length > 0) {
      await emitDelegatedReviewIfChild(tx, { runId, ...rows[0], cause });
    }

    return rows;
  });
}

// ADR-160: release a rework claim back to Review — NOT NeedsInput, because this
// provenance has no review HITL to re-open.
export async function markReviewFromReworkClaim(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await casToReviewAndEmit(
    db,
    runId,
    { status: "Review" },
    "HumanWorking",
    "rework_released",
  );

  if (rows.length === 0) {
    log.warn(
      { runId, from: "HumanWorking", to: "Review" },
      "markReviewFromReworkClaim: status-guard mismatch — concurrent return/abandon won",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "HumanWorking", to: "Review" },
    "run-state transition — rework claim released back to Review",
  );

  return { ok: true };
}

export async function markSyncFromReview(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({ status: "Running", checkpointAt: null, keepaliveUntil: null })
    .where(and(eq(runs.id, runId), eq(runs.status, "Review")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.warn(
      { runId, from: "Review", to: "Running" },
      "markSyncFromReview: status-guard mismatch — concurrent promote/sync won",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "Review", to: "Running" },
    "run-state transition — sync AI resolver opened the run",
  );

  return { ok: true };
}

// ADR-141: Running → Review. The branch-sync AI resolver finalizes (success or
// failure) by returning the run to the status the sync started from. Status-
// guarded on Running (the markSyncFromReview flip); clears keepalive/checkpoint.
// Does NOT touch review_entered_at — the success finalize resets it only when
// HEAD moved (decision 13), the failure restore leaves it untouched.
export async function markSyncReviewFromRunning(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await casToReviewAndEmit(
    db,
    runId,
    { status: "Review", keepaliveUntil: null, checkpointAt: null },
    "Running",
    "sync_returned",
  );

  if (rows.length === 0) {
    log.warn(
      { runId, from: "Running", to: "Review" },
      "markSyncReviewFromRunning: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  // ADR-164 D7: the resolver's driver generation ends with the flip.
  await releaseAssignmentForRun(db, runId, "sync_finished");
  log.info(
    { runId, from: "Running", to: "Review" },
    "run-state transition — sync AI resolver returned the run to Review",
  );

  return { ok: true };
}

// ADR-141 W7: {NeedsInput, NeedsInputIdle} → Review. A sync resolver parks HERE by
// design (an ACP `requestPermission` moves the run to NeedsInput), so once its
// in-process driver is gone the prompt is unanswerable and the run would hold a
// pool slot and the sync claim forever. Status-guarded on the EXACT observed
// status so this cannot clobber a run that answered its prompt and resumed to
// `Running` concurrently — that row is W2/W5's, not this arm's.
export async function markSyncReviewFromNeedsInput(
  runId: string,
  fromStatus: "NeedsInput" | "NeedsInputIdle",
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await casToReviewAndEmit(
    db,
    runId,
    { status: "Review", keepaliveUntil: null, checkpointAt: null },
    fromStatus,
    "sync_returned",
  );

  if (rows.length === 0) {
    log.warn(
      { runId, from: fromStatus, to: "Review" },
      "markSyncReviewFromNeedsInput: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  // ADR-164 D7: the resolver's driver generation ends with the flip.
  await releaseAssignmentForRun(db, runId, "sync_finished");
  log.info(
    { runId, from: fromStatus, to: "Review" },
    "run-state transition — orphaned sync resolver abandoned its HITL prompt",
  );

  return { ok: true };
}

// ADR-141 (decision 14): Done → Review. `reopen` pulls a finished run back to
// Review when its PR is still open or has fallen into conflict, so the branch can
// be synced and re-promoted against the moved target. `Done` is otherwise
// TERMINAL — this is the sole exact-allow-list CAS off it. Status-guarded on
// `Done` so a concurrent reopen (or any late terminal write) converges to ONE
// winner (loser → CONFLICT at the caller). Clears `ended_at`: a reopened run is
// live again, not terminal. The caller (reopenRun) stamps review_entered_at and
// flips promotion_state='reopened' in the SAME transaction.
export async function markReopenFromDone(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({ status: "Review", endedAt: null })
    .where(and(eq(runs.id, runId), eq(runs.status, "Done")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.warn(
      { runId, from: "Done", to: "Review" },
      "markReopenFromDone: status-guard mismatch — run is no longer Done",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "Done", to: "Review" },
    "run-state transition — reopened for branch sync / re-promotion",
  );

  return { ok: true };
}

// M8 T7: activity ping extends the keep-alive window without changing
// status. Status guard: only Running and NeedsInput rows accept a bump.
// NeedsInputIdle rows do NOT accept bumps — the activity route returns
// 409 with a hint to /respond instead.
export async function bumpKeepalive(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({ keepaliveUntil: nextKeepaliveAt() })
    .where(
      and(eq(runs.id, runId), inArray(runs.status, ["Running", "NeedsInput"])),
    )
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.debug({ runId }, "bumpKeepalive: status-guard mismatch");

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.debug({ runId }, "bumpKeepalive: extended");

  return { ok: true };
}

export type FailReason = string;

// M8 D7 failure rows that produce terminal Failed via failResumedRun:
//   - supervisor 400 spawn refused (CHECKPOINT)
//   - supervisor 201 but empty acpSessionId (CHECKPOINT)
//   - supervisor 404 unknown checkpoint (CHECKPOINT)
//
// M8 review finding #3: with the new claim-before-spawn order in
// resumeRun the post-claim row is NeedsInput, not NeedsInputIdle. The
// status guard accepts both so the terminal Failed transition fires
// regardless of which side of the claim the spawn happened on.
export async function failResumedRun(
  runId: string,
  reason: FailReason,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();

  const failed: boolean = await db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({ status: "Failed", endedAt: new Date() })
      .where(
        and(
          eq(runs.id, runId),
          inArray(runs.status, ["NeedsInputIdle", "NeedsInput"]),
        ),
      )
      .returning({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        flowId: runs.flowId,
        runKind: runs.runKind,
        parentRunId: runs.parentRunId,
      });

    if (rows.length === 0) return false;

    await releaseAssignmentForRun(tx, runId, "failed");

    await emitWebhookEvent({
      db: tx,
      type: "run.failed",
      projectId: rows[0].projectId,
      runId,
      data: { errorCode: reason ?? null },
    });

    await emitDomainEvent({
      db: tx,
      kind: "run.failed",
      projectId: rows[0].projectId,
      runId,
      taskId: rows[0].taskId,
      actor: { type: "system", id: null },
      parentRunId: rows[0].parentRunId,
      payload: {
        runId,
        taskId: rows[0].taskId,
        flowId: rows[0].flowId,
        runKind: rows[0].runKind,
        reason,
      },
    });

    return true;
  });

  if (!failed) {
    log.warn(
      { runId, to: "Failed", reason },
      "failResumedRun: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.warn(
    { runId, to: "Failed", reason },
    "run-state transition — failed during resume",
  );
  return { ok: true };
}

// M8 review finding #3: when the atomic claim path
// (markResumed BEFORE createSession) has to undo itself because the
// supervisor spawn failed with a RETRYABLE error, we transition the
// run back to NeedsInputIdle so the next operator response (or the
// next sweeper pass) sees the original state. Status guard restricted
// to `NeedsInput` so a concurrent terminal transition (e.g.
// crashResumedRun) cannot be overwritten by the rollback.
export async function rollbackResumedRun(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rolledBack: boolean = await db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({
        status: "NeedsInputIdle",
        checkpointAt: new Date(),
        keepaliveUntil: null,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
      .returning({ id: runs.id });

    if (rows.length === 0) return false;

    // ADR-164: the fresh epoch the resume claim minted never got a driver.
    await releaseAssignmentForRun(tx, runId, "resume_rollback");

    return true;
  });

  if (!rolledBack) {
    log.warn(
      { runId, from: "NeedsInput", to: "NeedsInputIdle (rollback)" },
      "rollbackResumedRun: status-guard mismatch — concurrent transition won",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "NeedsInput", to: "NeedsInputIdle (rollback)" },
    "run-state transition — resume claim rolled back after retryable spawn failure",
  );

  return { ok: true };
}

// M11b D2 (ADR-030): NeedsInput → HumanWorking on a takeover claim. The
// reviewer parked at a human_review node claims the run to edit its worktree
// by hand. Status-guarded CAS: a concurrent claim loses and gets
// {ok:false} → the route maps it to 409 CONFLICT. The owner is recorded on
// the takeover node_attempts row (claimTakeover) — this helper only flips the
// run status. HumanWorking holds a concurrency slot and is session-less.
export async function markHumanWorking(
  runId: string,
  userId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const rows = await db
    .update(runs)
    .set({ status: "HumanWorking" })
    .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
    log.warn(
      { runId, userId, from: "NeedsInput", to: "HumanWorking" },
      "markHumanWorking: status-guard mismatch — concurrent claim lost",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, userId, from: "NeedsInput", to: "HumanWorking" },
    "run-state transition — takeover claimed",
  );

  return { ok: true };
}

// M11b (ADR-030): HumanWorking → Running on takeover return. The AFTER-side
// idempotency marker of the two-phase return — set ONLY after git log/diff +
// recordTakeoverReturn + markDownstreamStale all succeed. Status-guarded so a
// duplicate return (already Running) loses → {ok:false} → 409 PRECONDITION.
export async function markReturnedToRunning(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const returned: boolean = await db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({ status: "Running" })
      .where(and(eq(runs.id, runId), eq(runs.status, "HumanWorking")))
      .returning({ id: runs.id });

    if (rows.length === 0) return false;

    // The returned run is re-driven by a new generation (ADR-164 D3).
    await mintForClaim(tx, runId, "rework_return", opts);

    return true;
  });

  if (!returned) {
    log.warn(
      { runId, from: "HumanWorking", to: "Running" },
      "markReturnedToRunning: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "HumanWorking", to: "Running" },
    "run-state transition — takeover returned, resuming validation path",
  );

  return { ok: true };
}

// M11b (ADR-030): HumanWorking → NeedsInput on release-without-changes. The
// reviewer claimed the run but made no edits; the original review HITL
// re-opens. Status-guarded; a non-HumanWorking row loses → {ok:false}. The
// status flip and the takeover ledger close commit in ONE transaction so a
// released/abandoned run never lingers with an open handoff
// (getActiveTakeover): release OR the abandon path (which calls this first)
// leaves NO active takeover.
export async function releaseHumanWorking(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const { endActiveTakeover } = await import("@/lib/flows/graph/ledger");

  const released: boolean = await db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({ status: "NeedsInput" })
      .where(and(eq(runs.id, runId), eq(runs.status, "HumanWorking")))
      .returning({ id: runs.id });

    if (rows.length === 0) return false;

    await endActiveTakeover(runId, tx);

    return true;
  });

  if (!released) {
    log.warn(
      { runId, from: "HumanWorking", to: "NeedsInput" },
      "releaseHumanWorking: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "HumanWorking", to: "NeedsInput" },
    "run-state transition — takeover released (no changes)",
  );

  return { ok: true };
}

// M11b Phase 3.5 (Phase 0.10): user-facing run abandon. The abandon route
// (web/app/api/runs/[runId]/abandon/route.ts) calls this after first running
// releaseHumanWorking on a HumanWorking run, so the guard accepts the
// non-terminal abandonable set. Status-guarded so a duplicate/concurrent
// abandon on an already-terminal row loses → {ok:false} → 409. The caller runs
// promoteNextPending after a successful abandon to free the slot.
export const ABANDONABLE_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  // M37 (ADR-098): a parked orchestrator is directly abandonable; abandon
  // cascades to its run-tree (T7.4).
  "WaitingOnChildren",
  "Review",
  "Crashed",
] as const;

export async function markAbandoned(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();

  const abandoned: boolean = await db.transaction(async (tx: Db) => {
    const endedAt = new Date();
    const rows = await tx
      .update(runs)
      .set({ status: "Abandoned", endedAt })
      .where(
        and(
          eq(runs.id, runId),
          inArray(runs.status, [...ABANDONABLE_STATUSES]),
        ),
      )
      .returning({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        flowId: runs.flowId,
        runKind: runs.runKind,
        parentRunId: runs.parentRunId,
      });

    if (rows.length === 0) return false;

    await releaseSyncClaimOnTerminal(tx, runId, "CRASH");
    await releaseAssignmentForRun(tx, runId, "abandoned");

    // M19 Phase 1 (T1.C): stamp the GC removal deadline on the run's
    // workspace in the SAME tx so an abandoned run never lingers with a
    // null scheduled_removal_at. Same endedAt instant the run row carries.
    const scheduledRemovalAt = new Date(
      endedAt.getTime() + gcAgeDays() * 86_400_000,
    );

    await tx
      .update(workspaces)
      .set({ scheduledRemovalAt })
      .where(eq(workspaces.runId, runId));

    log.debug(
      { runId, at: scheduledRemovalAt },
      "[scheduler] scheduled_removal_at stamped",
    );

    await emitWebhookEvent({
      db: tx,
      type: "run.abandoned",
      projectId: rows[0].projectId,
      runId,
      data: { source: "user" },
    });

    await emitDomainEvent({
      db: tx,
      kind: "run.abandoned",
      projectId: rows[0].projectId,
      runId,
      taskId: rows[0].taskId,
      actor: { type: "system", id: null },
      parentRunId: rows[0].parentRunId,
      payload: {
        runId,
        taskId: rows[0].taskId,
        flowId: rows[0].flowId,
        runKind: rows[0].runKind,
        reason: "user",
      },
    });

    return true;
  });

  if (!abandoned) {
    log.warn(
      { runId, to: "Abandoned" },
      "markAbandoned: status-guard mismatch — already terminal or gone",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  // ADR-157 (T32): an abandoned run's read-only sibling mounts are released from
  // the launch snapshot on `runs.context_mounts`. Lazy import mirrors the
  // ledger import above — keeps this leaf module out of the agent/social graph.
  try {
    const { releaseRunContextMounts } = await import(
      "@/lib/context-mounts/terminal"
    );

    await releaseRunContextMounts({ runId, db });
  } catch (err) {
    log.warn(
      { runId, err: err instanceof Error ? err.message : String(err) },
      "context mount release on abandon failed — left to the GC backstop",
    );
  }

  log.info({ runId, to: "Abandoned" }, "run-state transition — abandoned");
  return { ok: true };
}

// M8 D9 / T11: NeedsInput → Crashed when the runner-agent's
// resume-prompt watchdog expires (the resumed session was supposed to
// re-issue session.permission_request within
// `MAISTER_RESUME_PROMPT_TIMEOUT_SECONDS` but did not).
export async function crashResumedRun(
  runId: string,
  reason: FailReason,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();

  const crashed: boolean = await db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({ status: "Crashed", endedAt: new Date() })
      .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
      .returning({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        flowId: runs.flowId,
        runKind: runs.runKind,
        parentRunId: runs.parentRunId,
      });

    if (rows.length === 0) return false;

    await releaseSyncClaimOnTerminal(tx, runId, reason ?? "CRASH");
    await releaseAssignmentForRun(tx, runId, "crashed");

    await emitWebhookEvent({
      db: tx,
      type: "run.crashed",
      projectId: rows[0].projectId,
      runId,
      data: { errorCode: reason ?? null },
    });

    await emitDomainEvent({
      db: tx,
      kind: "run.crashed",
      projectId: rows[0].projectId,
      runId,
      taskId: rows[0].taskId,
      actor: { type: "system", id: null },
      parentRunId: rows[0].parentRunId,
      payload: {
        runId,
        taskId: rows[0].taskId,
        flowId: rows[0].flowId,
        runKind: rows[0].runKind,
        reason,
      },
    });

    return true;
  });

  if (!crashed) {
    log.warn(
      { runId, from: "NeedsInput", to: "Crashed", reason },
      "crashResumedRun: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.warn(
    { runId, from: "NeedsInput", to: "Crashed", reason },
    "run-state transition — crashed during resume",
  );
  return { ok: true };
}

// M19 Phase 1 (T1.A): Running → Crashed when reconciliation/GC finds a
// Running row whose worktree is gone, whose agent session has vanished, or
// that sits parked on a CLI step that is not retry-safe. Mirrors
// crashResumedRun's shape but guards on status='Running' and additionally
// clears current_step_id + resume_started_at so the row reads as a clean
// terminal crash. The caller (reconcile/GC) owns the promoteNextPending
// follow-up — this helper only flips the run state (§3.3).
export type CrashReason =
  | "worktree-gone"
  | "agent-session-gone"
  | "cli-not-retry-safe"
  // M37 (ADR-098) T7.1: a Running child whose coordinator parent is gone.
  | "orphaned-child"
  // M37 (ADR-098) T7.1: a parked orchestrator with no resumable wake left.
  | "orchestrator-stuck";

export async function crashRunningRun(
  runId: string,
  reason: CrashReason,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();

  log.debug({ runId, reason }, "[state-transitions.crashRunningRun] entry");

  const crashed: boolean = await db.transaction(async (tx: Db) => {
    // M19 crash-recover (ADR-034): retain the crashed node id in
    // resume_target_step_id BEFORE nulling current_step_id, so Recover can resolve
    // the node kind (agent → --resume; session-less + retry_safe → re-dispatch).
    // current_step_id is still nulled for the clean-terminal reconcile read. The
    // SET right-hand sides evaluate against the pre-update row, so
    // resume_target_step_id captures the OLD current_step_id in one statement.
    const rows = await tx
      .update(runs)
      .set({
        status: "Crashed",
        endedAt: new Date(),
        resumeTargetStepId: sql`${runs.currentStepId}`,
        currentStepId: null,
        resumeStartedAt: null,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "Running")))
      .returning({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        flowId: runs.flowId,
        runKind: runs.runKind,
        parentRunId: runs.parentRunId,
      });

    if (rows.length === 0) return false;

    await releaseSyncClaimOnTerminal(tx, runId, reason ?? "CRASH");
    await releaseAssignmentForRun(tx, runId, "crashed");

    await emitWebhookEvent({
      db: tx,
      type: "run.crashed",
      projectId: rows[0].projectId,
      runId,
      data: { errorCode: reason ?? null },
    });

    await emitDomainEvent({
      db: tx,
      kind: "run.crashed",
      projectId: rows[0].projectId,
      runId,
      taskId: rows[0].taskId,
      actor: { type: "system", id: null },
      parentRunId: rows[0].parentRunId,
      payload: {
        runId,
        taskId: rows[0].taskId,
        flowId: rows[0].flowId,
        runKind: rows[0].runKind,
        reason,
      },
    });

    return true;
  });

  if (!crashed) {
    log.warn(
      { runId, from: "Running", to: "Crashed", reason },
      "crashRunningRun: status-guard mismatch",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "Running", to: "Crashed", reason },
    "run-state transition — crashed (reconcile/GC)",
  );
  return { ok: true };
}

// M37 (ADR-098) T7.1: WaitingOnChildren → Crashed when reconcile finds a parked
// orchestrator that is genuinely stuck — no live session, no non-terminal
// children, past the grace window. Mirrors crashRunningRun (retains the parked
// node in resume_target_step_id, nulls current_step_id + resume_started_at,
// clears the checkpoint so the row reads as a clean terminal crash, and emits
// run.crashed with parent_run_id). Status-guarded on WaitingOnChildren so a
// concurrent wake (markResumedFromWait) that already moved the row to Running
// loses → {ok:false}. The caller cascades the leftover children FIRST, then
// crashes the coordinator, and owns the promoteNextPending follow-up.
export async function crashWaitingOnChildren(
  runId: string,
  reason: CrashReason,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();

  const crashed: boolean = await db.transaction(async (tx: Db) => {
    const rows = await tx
      .update(runs)
      .set({
        status: "Crashed",
        endedAt: new Date(),
        resumeTargetStepId: sql`${runs.currentStepId}`,
        currentStepId: null,
        resumeStartedAt: null,
        checkpointAt: null,
        keepaliveUntil: null,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "WaitingOnChildren")))
      .returning({
        id: runs.id,
        projectId: runs.projectId,
        taskId: runs.taskId,
        flowId: runs.flowId,
        runKind: runs.runKind,
        parentRunId: runs.parentRunId,
      });

    if (rows.length === 0) return false;

    await releaseSyncClaimOnTerminal(tx, runId, reason ?? "CRASH");
    await releaseAssignmentForRun(tx, runId, "crashed");

    await emitWebhookEvent({
      db: tx,
      type: "run.crashed",
      projectId: rows[0].projectId,
      runId,
      data: { errorCode: reason ?? null },
    });

    await emitDomainEvent({
      db: tx,
      kind: "run.crashed",
      projectId: rows[0].projectId,
      runId,
      taskId: rows[0].taskId,
      actor: { type: "system", id: null },
      parentRunId: rows[0].parentRunId,
      payload: {
        runId,
        taskId: rows[0].taskId,
        flowId: rows[0].flowId,
        runKind: rows[0].runKind,
        reason,
      },
    });

    return true;
  });

  if (!crashed) {
    log.warn(
      { runId, from: "WaitingOnChildren", to: "Crashed", reason },
      "crashWaitingOnChildren: status-guard mismatch — concurrent wake won",
    );

    return { ok: false, reason: "status-guard-mismatch" };
  }

  log.info(
    { runId, from: "WaitingOnChildren", to: "Crashed", reason },
    "run-state transition — orchestrator crashed (reconcile)",
  );
  return { ok: true };
}
