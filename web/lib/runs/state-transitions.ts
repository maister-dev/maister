import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import pino from "pino";

import { nextKeepaliveAt } from "./keepalive-config";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { gcAgeDays } from "@/lib/instance-config";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, workspaces } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "run-state",
  level: process.env.LOG_LEVEL ?? "info",
});

export type StateTransitionResult =
  | { ok: true }
  | { ok: false; reason: "status-guard-mismatch" | "not-found" };

export type StateTransitionOptions = {
  db?: Db;
  recordSuccessAudit?: (db: Db) => Promise<void>;
};

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
  const rows = await db
    .update(runs)
    .set({
      status: "NeedsInputIdle",
      checkpointAt: new Date(),
      keepaliveUntil: null,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
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
  const rows = await db
    .update(runs)
    .set({
      status: "NeedsInputIdle",
      checkpointAt: new Date(),
      keepaliveUntil: null,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
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
  const transition = async (tx: Db): Promise<StateTransitionResult> => {
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

    await opts.recordSuccessAudit?.(tx);

    log.info(
      { runId, from: "NeedsInputIdle", to: "NeedsInput" },
      "run-state transition",
    );

    return { ok: true };
  };

  if (opts.recordSuccessAudit) {
    return await (db as { transaction: any }).transaction(transition);
  }

  return await transition(db);
}

// M36 (ADR-095): Running → WaitingOnChildren. The orchestrator node yields
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

  log.info(
    { runId, from: "Running", to: "WaitingOnChildren" },
    "run-state transition",
  );

  return { ok: true };
}

// M36 (ADR-095): WaitingOnChildren → Running. A child-terminal domain event (or
// a manual resume) wakes the parked orchestrator; the supervisor respawns +
// session/resume restores context. Status-guarded so a concurrent event-resume
// + manual-resume converge to a single winner (the loser → 409); clears
// checkpoint_at so the resumed run reads as a fresh live session.
export async function markResumedFromWait(
  runId: string,
  opts: StateTransitionOptions = {},
): Promise<StateTransitionResult> {
  const db = opts.db ?? getDb();
  const transition = async (tx: Db): Promise<StateTransitionResult> => {
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

    await opts.recordSuccessAudit?.(tx);

    log.info(
      { runId, from: "WaitingOnChildren", to: "Running" },
      "run-state transition",
    );

    return { ok: true };
  };

  if (opts.recordSuccessAudit) {
    return await (db as { transaction: any }).transaction(transition);
  }

  return await transition(db);
}

// M36 (ADR-095) T5.2: Running → WaitingOnChildren rollback. After the resume
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

// M36 (ADR-097): Review → Running. `run_rework` re-opens a DELEGATED child whose
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
  const rows = await db
    .update(runs)
    .set({
      status: "NeedsInputIdle",
      checkpointAt: new Date(),
      keepaliveUntil: null,
    })
    .where(and(eq(runs.id, runId), eq(runs.status, "NeedsInput")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
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
  const rows = await db
    .update(runs)
    .set({ status: "Running" })
    .where(and(eq(runs.id, runId), eq(runs.status, "HumanWorking")))
    .returning({ id: runs.id });

  if (rows.length === 0) {
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
const ABANDONABLE_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  // M36 (ADR-095): a parked orchestrator is directly abandonable; abandon
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
  // M17 (ADR-056): a session-less linear (flat `steps[]`) run parked on a
  // gate/human node — no graph mid-flow resume, so reconcile crashes it and
  // Recover resumes from resume_target_step_id (window-(c)).
  | "linear-gate-orphan"
  // M36 (ADR-095) T7.1: a Running child whose coordinator parent is gone.
  | "orphaned-child"
  // M36 (ADR-095) T7.1: a parked orchestrator with no resumable wake left.
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

// M36 (ADR-095) T7.1: WaitingOnChildren → Crashed when reconcile finds a parked
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
