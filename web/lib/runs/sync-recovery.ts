import "server-only";

import { and, desc, eq, notInArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { hasSyncDriver } from "@/lib/runs/sync-driver-registry";
import { SYNC_STEP_ID } from "@/lib/runs/sync-resolver";
import { markSyncReviewFromRunning } from "@/lib/runs/state-transitions";
import { pushWithLease, verifySyncGate } from "@/lib/runs/sync-target";
import { poolForRunKind, promoteNextPending } from "@/lib/scheduler";
import {
  deleteSession as realDeleteSession,
  listSessions as realListSessions,
  type SupervisorSessionRecord,
} from "@/lib/supervisor-client";
import {
  abortSyncOperation,
  branchHasUpstream,
  headCommit,
  localBranchHead,
  remoteBranchHead,
  restoreWorktreeToCommit,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants — mirror sync-target.ts.
const { runs, workspaces, projects, runSyncAttempts } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): the injected db seam is a Drizzle client OR a Testcontainers pg
// client; both expose select/insert/update/transaction.
type Db = any;

const log = pino({
  name: "sync-recovery",
  level: process.env.LOG_LEVEL ?? "info",
});

// Decision 16: the active-time duration cap measures ONLY continuous `Running`
// time from `agent_running_since` (re-stamped on every NeedsInput→Running HITL
// resume by `markSyncResolverPermissionDelivered` in `lib/services/hitl.ts`); a
// `NeedsInput` human-pause never counts.
export const SYNC_ATTEMPT_MAX_MINUTES = 30;

const TERMINAL_PHASES = ["succeeded", "failed", "aborted"] as const;

type DeleteSessionFn = (sessionId: string) => Promise<void>;

type AttemptRow = {
  id: string;
  runId: string;
  workspaceId: string;
  phase: string;
  mode: string;
  headShaBefore: string | null;
  remoteShaBefore: string | null;
  agentRunningSince: Date | null;
};

type RunContext = {
  runKind: string;
  worktree: string;
  branch: string;
  repo: string;
  targetBranch: string;
  prUrl: string | null;
};

async function loadActiveAttempt(
  db: Db,
  runId: string,
): Promise<AttemptRow | null> {
  const rows = await db
    .select({
      id: runSyncAttempts.id,
      runId: runSyncAttempts.runId,
      workspaceId: runSyncAttempts.workspaceId,
      phase: runSyncAttempts.phase,
      mode: runSyncAttempts.mode,
      headShaBefore: runSyncAttempts.headShaBefore,
      remoteShaBefore: runSyncAttempts.remoteShaBefore,
      agentRunningSince: runSyncAttempts.agentRunningSince,
    })
    .from(runSyncAttempts)
    .where(
      and(
        eq(runSyncAttempts.runId, runId),
        notInArray(
          runSyncAttempts.phase,
          TERMINAL_PHASES as unknown as string[],
        ),
      ),
    )
    .orderBy(desc(runSyncAttempts.attempt))
    .limit(1);

  return rows[0] ?? null;
}

async function loadRunContext(
  db: Db,
  runId: string,
): Promise<RunContext | null> {
  const rows = await db
    .select({
      runKind: runs.runKind,
      projectMainBranch: projects.mainBranch,
      worktree: workspaces.worktreePath,
      branch: workspaces.branch,
      repo: workspaces.parentRepoPath,
      targetBranch: workspaces.targetBranch,
      prUrl: workspaces.prUrl,
    })
    .from(runs)
    .innerJoin(workspaces, eq(workspaces.runId, runs.id))
    .leftJoin(projects, eq(projects.id, runs.projectId))
    .where(eq(runs.id, runId))
    .limit(1);
  const row = rows[0];

  if (!row) return null;

  return {
    runKind: row.runKind as string,
    worktree: row.worktree as string,
    branch: row.branch as string,
    repo: row.repo as string,
    targetBranch:
      (row.targetBranch as string | null) ??
      (row.projectMainBranch as string | null) ??
      "main",
    prUrl: (row.prUrl as string | null) ?? null,
  };
}

async function setPhaseFailed(
  db: Db,
  attemptId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await db
    .update(runSyncAttempts)
    .set({ phase: "failed", errorCode, errorMessage, updatedAt: new Date() })
    .where(eq(runSyncAttempts.id, attemptId));
}

async function setPhaseSucceeded(
  db: Db,
  attemptId: string,
  extra: { headShaAfter: string; pushed: boolean },
): Promise<void> {
  await db
    .update(runSyncAttempts)
    .set({ phase: "succeeded", ...extra, updatedAt: new Date() })
    .where(eq(runSyncAttempts.id, attemptId));
}

// Free the shared lifecycle slot this attempt holds — idempotent (guarded on
// `sync`, so a second call after release matches no row) and never releases
// another op's claim. Mirrors sync-target.ts `releaseSyncClaim`.
async function releaseClaim(db: Db, workspaceId: string): Promise<void> {
  await db
    .update(workspaces)
    .set({
      lifecycleOperationState: "none",
      lifecycleOperationClaimedAt: null,
      lifecycleOperationAttemptId: null,
      lifecycleOperationName: null,
    })
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.lifecycleOperationName, "sync"),
      ),
    );
}

// Restore the worktree to its pre-sync HEAD (or just abort a half-op when the
// pre-sync SHA was never recorded — the `starting` phase). `restoreWorktreeToCommit`
// aborts any in-progress rebase/merge first, so it subsumes `abortSyncOperation`.
async function restoreWorktree(
  worktree: string,
  headShaBefore: string | null,
): Promise<void> {
  try {
    if (headShaBefore) {
      await restoreWorktreeToCommit(worktree, headShaBefore);
    } else {
      await abortSyncOperation(worktree);
    }
  } catch (err) {
    log.error(
      { worktree, err: err instanceof Error ? err.message : String(err) },
      "sync recovery worktree restore failed",
    );
  }
}

// The shared agent-path terminal: (optionally restore), fail the attempt, release
// the claim, CAS the run Running→Review, and free the pool slot. Every branch that
// leaves a `Running` sync run does this, so no path strands `Running` or a claim.
async function failAgentAttemptToReview(
  db: Db,
  args: {
    attempt: AttemptRow;
    ctx: RunContext;
    errorCode: string;
    errorMessage: string;
    restore: boolean;
  },
): Promise<void> {
  if (args.restore) {
    await restoreWorktree(args.ctx.worktree, args.attempt.headShaBefore);
  }
  await setPhaseFailed(db, args.attempt.id, args.errorCode, args.errorMessage);
  await releaseClaim(db, args.attempt.workspaceId);
  await markSyncReviewFromRunning(args.attempt.runId, { db });
  await promoteNextPending({ db, pool: poolForRunKind(args.ctx.runKind) });
}

export type ReconcileSyncOutcome = {
  window: "w2" | "w3";
  outcome: "aborted" | "finalized" | "noop";
};

/**
 * ADR-140 (Task 11) — the reconcile-side branch-sync recovery executor for the
 * AGENT resolver path (the run is `Running`). Invoked by `runReconcileSweep` only
 * after the classifier routes a `Running + activeSyncAttempt` candidate to
 * `sync-recover` (never the flow reattach/redispatch arms):
 *
 *  - **W2** (`liveSessionId` set — an orphaned live resolver session with no
 *    in-proc driver, i.e. post-restart): tear the session down, restore the
 *    pre-sync HEAD, fail the attempt, and return the run to `Review`.
 *  - **W2/W3** (no live session): idempotently re-run the verify gate — a passing
 *    gate means the resolve completed, so finalize (push is explicit-SHA
 *    force-with-lease, idempotent to the recorded remote SHA) and return to
 *    `Review`; a failing gate aborts (restore) and returns to `Review`.
 *
 * Every path frees the pool slot via `promoteNextPending`. Idempotent: a
 * concurrent in-process finalize that already terminalized the attempt leaves no
 * active attempt row → `noop`.
 */
export async function recoverSyncAttemptOnReconcile(args: {
  runId: string;
  liveSessionId: string | null;
  db?: Db;
  deleteSession?: DeleteSessionFn;
  now?: () => Date;
}): Promise<ReconcileSyncOutcome> {
  const db = (args.db ?? getDb()) as Db;
  const now = args.now ?? (() => new Date());
  const del = args.deleteSession ?? realDeleteSession;
  const { runId } = args;

  const attempt = await loadActiveAttempt(db, runId);

  if (!attempt) {
    // A concurrent in-process finalize won the race and terminalized the attempt.
    return { window: args.liveSessionId ? "w2" : "w3", outcome: "noop" };
  }

  const ctx = await loadRunContext(db, runId);

  if (!ctx) {
    // No workspace — cannot act on git; just terminalize the ledger + claim.
    await setPhaseFailed(
      db,
      attempt.id,
      "CRASH",
      "sync recovery: run context gone",
    );
    await releaseClaim(db, attempt.workspaceId);

    return { window: args.liveSessionId ? "w2" : "w3", outcome: "aborted" };
  }

  // --- W2: an orphaned LIVE resolver session with no in-proc driver -----------
  if (args.liveSessionId) {
    await del(args.liveSessionId).catch(() => undefined);
    await failAgentAttemptToReview(db, {
      attempt,
      ctx,
      errorCode: "CRASH",
      errorMessage:
        "reconcile: orphaned live sync resolver session (no in-proc driver)",
      restore: true,
    });
    log.info(
      { window: "w2", runId, attempt: attempt.id },
      "sync recovery: aborted orphaned live resolver session, returned run to Review",
    );

    return { window: "w2", outcome: "aborted" };
  }

  // --- W2/W3: no live session — idempotent re-verify → finalize or abort -------
  const targetSha =
    (await localBranchHead({
      projectRepoPath: ctx.repo,
      branch: ctx.targetBranch,
    })) ?? ctx.targetBranch;
  const gate = await verifySyncGate(ctx.worktree, targetSha);

  if (!gate.ok) {
    await failAgentAttemptToReview(db, {
      attempt,
      ctx,
      errorCode: "CRASH",
      errorMessage: `reconcile: sync resolver crashed, verify gate failed (${gate.reason})`,
      restore: true,
    });
    log.info(
      { window: "w3", runId, attempt: attempt.id, reason: gate.reason },
      "sync recovery: verify gate failed on recovery, aborted to Review",
    );

    return { window: "w3", outcome: "aborted" };
  }

  // Gate passed → the resolve completed before the crash. Idempotently finalize:
  // push (explicit-SHA lease) iff published, then succeed + return to Review.
  const headShaAfter = await headCommit({ worktreePath: ctx.worktree });
  const published =
    ctx.prUrl != null ||
    (await branchHasUpstream(ctx.repo, ctx.branch).catch(() => false));
  let pushed = false;

  if (published) {
    const push = await pushWithLease(
      ctx.worktree,
      ctx.branch,
      attempt.remoteShaBefore,
    );

    if (push.pushed) {
      pushed = true;
    } else {
      // Lease rejected. Either the push ALREADY landed before the crash (remote
      // now equals the local head → treat as pushed) or the branch genuinely
      // moved remotely (a real conflict → fail, keep the local result).
      const remoteHead = await remoteBranchHead({
        projectRepoPath: ctx.repo,
        remote: "origin",
        branch: ctx.branch,
      }).catch(() => null);

      if (
        remoteHead &&
        remoteHead.toLowerCase() === headShaAfter.toLowerCase()
      ) {
        pushed = true;
      } else {
        await failAgentAttemptToReview(db, {
          attempt,
          ctx,
          errorCode: "CONFLICT",
          errorMessage:
            "reconcile: force-with-lease rejected on recovery (branch moved on origin); local result kept",
          restore: false,
        });
        log.info(
          { window: "w3", runId, attempt: attempt.id },
          "sync recovery: lease rejected on recovery, kept local result, returned to Review",
        );

        return { window: "w3", outcome: "aborted" };
      }
    }
  }

  await setPhaseSucceeded(db, attempt.id, { headShaAfter, pushed });
  if (attempt.headShaBefore && headShaAfter !== attempt.headShaBefore) {
    // HEAD moved (decision 13) — restart the auto-promotion grace window.
    await db
      .update(runs)
      .set({ reviewEnteredAt: now() })
      .where(eq(runs.id, runId));
  }
  await releaseClaim(db, attempt.workspaceId);
  await markSyncReviewFromRunning(runId, { db });
  await promoteNextPending({ db, pool: poolForRunKind(ctx.runKind) });
  log.info(
    { window: "w3", runId, attempt: attempt.id, pushed },
    "sync recovery: finalized completed resolve, returned run to Review",
  );

  return { window: "w3", outcome: "finalized" };
}

// --- system sweep: W1/W4 orphan-operation recovery + W5 duration cap ----------

export interface SyncRecoverySweepOptions {
  db?: Db;
  now?: () => Date;
  listSessions?: () => Promise<SupervisorSessionRecord[]>;
  deleteSession?: DeleteSessionFn;
}

export interface SyncRecoverySweepSummary {
  candidates: number;
  // W1/W4: mechanical syncs orphaned by a restart (attempt starting/rebasing, no
  // in-proc driver) — aborted, attempt failed, claim released. Run stays Review.
  orphanOperationsAborted: number;
  // W5: agent resolvers that exceeded the continuous-Running active-time cap —
  // session killed, restored, attempt failed, run returned to Review.
  durationCapKilled: number;
}

type SweepCandidate = {
  attempt: AttemptRow;
  runStatus: string;
  runKind: string;
  worktree: string;
  workspaceId: string;
};

async function loadSweepCandidates(db: Db): Promise<SweepCandidate[]> {
  const rows = await db
    .select({
      id: runSyncAttempts.id,
      runId: runSyncAttempts.runId,
      workspaceId: runSyncAttempts.workspaceId,
      phase: runSyncAttempts.phase,
      mode: runSyncAttempts.mode,
      headShaBefore: runSyncAttempts.headShaBefore,
      remoteShaBefore: runSyncAttempts.remoteShaBefore,
      agentRunningSince: runSyncAttempts.agentRunningSince,
      runStatus: runs.status,
      runKind: runs.runKind,
      worktree: workspaces.worktreePath,
    })
    .from(runSyncAttempts)
    .innerJoin(runs, eq(runs.id, runSyncAttempts.runId))
    .innerJoin(workspaces, eq(workspaces.id, runSyncAttempts.workspaceId))
    .where(
      notInArray(runSyncAttempts.phase, TERMINAL_PHASES as unknown as string[]),
    );

  return rows.map((row: Record<string, unknown>) => ({
    attempt: {
      id: row.id as string,
      runId: row.runId as string,
      workspaceId: row.workspaceId as string,
      phase: row.phase as string,
      mode: row.mode as string,
      headShaBefore: (row.headShaBefore ?? null) as string | null,
      remoteShaBefore: (row.remoteShaBefore ?? null) as string | null,
      agentRunningSince: (row.agentRunningSince ?? null) as Date | null,
    },
    runStatus: row.runStatus as string,
    runKind: row.runKind as string,
    worktree: row.worktree as string,
    workspaceId: row.workspaceId as string,
  }));
}

function liveSyncSessionFor(
  records: SupervisorSessionRecord[],
  runId: string,
): SupervisorSessionRecord | undefined {
  return records.find(
    (r) =>
      r.status === "live" && r.runId === runId && r.stepId === SYNC_STEP_ID,
  );
}

/**
 * ADR-140 (Task 11) — the system-sweep branch-sync recovery pass, run from
 * `runSystemSweep` on the polymorphic scheduler clock. It owns the crash windows
 * reconcile cannot see (the MECHANICAL sync never leaves `Review`, so it is not a
 * `Running` reconcile candidate) plus the active-time runaway:
 *
 *  - **W1/W4** — a mechanical sync orphaned by a web restart (attempt
 *    `starting`/`rebasing`, `mode='mechanical'`, no in-proc driver): abort the
 *    on-disk rebase, restore the pre-sync HEAD, fail the attempt, release the
 *    claim. The run stays `Review` (mechanical never held a pool slot).
 *  - **W5** — an agent resolver past the continuous-Running active-time cap
 *    (`phase='agent_running'`, run `Running`, `agent_running_since` older than
 *    `SYNC_ATTEMPT_MAX_MINUTES`): kill the session, restore, fail the attempt,
 *    return the run to `Review`, and promote the freed slot.
 *
 * (W6 — an `autoFinalize` chained-finalize crash — is a benign clean-`Review`
 * degradation, so it has no sweep arm.)
 */
export async function runSyncRecoverySweep(
  opts: SyncRecoverySweepOptions = {},
): Promise<SyncRecoverySweepSummary> {
  const db = (opts.db ?? getDb()) as Db;
  const now = opts.now ?? (() => new Date());
  const del = opts.deleteSession ?? realDeleteSession;
  const listSessions = opts.listSessions ?? realListSessions;

  const candidates = await loadSweepCandidates(db);

  if (candidates.length === 0) {
    return { candidates: 0, orphanOperationsAborted: 0, durationCapKilled: 0 };
  }

  // listSessions ONCE up front. On throw → skip the whole tick (never act on a
  // transient supervisor outage — the split-brain the keepalive/reconcile sweeps
  // also guard against).
  let records: SupervisorSessionRecord[];

  try {
    records = await listSessions();
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "sync recovery sweep: listSessions failed — skipping tick",
    );

    return {
      candidates: candidates.length,
      orphanOperationsAborted: 0,
      durationCapKilled: 0,
    };
  }

  const cutoffMs = now().getTime() - SYNC_ATTEMPT_MAX_MINUTES * 60_000;
  let orphanOperationsAborted = 0;
  let durationCapKilled = 0;

  for (const cand of candidates) {
    const { attempt } = cand;

    // W5: an agent resolver whose continuous-Running active time exceeded the cap.
    if (
      attempt.phase === "agent_running" &&
      cand.runStatus === "Running" &&
      attempt.agentRunningSince !== null &&
      attempt.agentRunningSince.getTime() < cutoffMs
    ) {
      const live = liveSyncSessionFor(records, attempt.runId);

      if (live) await del(live.sessionId).catch(() => undefined);
      await restoreWorktree(cand.worktree, attempt.headShaBefore);
      await setPhaseFailed(
        db,
        attempt.id,
        "CRASH",
        `sync resolver exceeded the ${SYNC_ATTEMPT_MAX_MINUTES}min active-time cap`,
      );
      await releaseClaim(db, attempt.workspaceId);
      await markSyncReviewFromRunning(attempt.runId, { db });
      await promoteNextPending({ db, pool: poolForRunKind(cand.runKind) });
      durationCapKilled += 1;
      log.warn(
        { window: "w5", runId: attempt.runId, attempt: attempt.id },
        "sync recovery: killed runaway resolver past active-time cap, returned run to Review",
      );

      continue;
    }

    // W1/W4: a MECHANICAL sync orphaned by a restart — no in-proc driver owns it.
    // A live in-flight mechanical sync in THIS process IS registered, so
    // `hasSyncDriver` excludes it (the skip-vs-abort discriminant).
    if (
      cand.attempt.mode === "mechanical" &&
      (attempt.phase === "starting" || attempt.phase === "rebasing") &&
      !hasSyncDriver(attempt.runId)
    ) {
      await restoreWorktree(cand.worktree, attempt.headShaBefore);
      await setPhaseFailed(
        db,
        attempt.id,
        "CRASH",
        "mechanical sync orphaned by restart (no in-proc driver)",
      );
      await releaseClaim(db, attempt.workspaceId);
      orphanOperationsAborted += 1;
      log.warn(
        {
          window: attempt.phase === "rebasing" ? "w4" : "w1",
          runId: attempt.runId,
          attempt: attempt.id,
        },
        "sync recovery: aborted orphaned mechanical sync, released claim (run stays Review)",
      );
    }
  }

  const summary = {
    candidates: candidates.length,
    orphanOperationsAborted,
    durationCapKilled,
  };

  if (orphanOperationsAborted > 0 || durationCapKilled > 0) {
    log.info(summary, "sync recovery sweep complete");
  }

  return summary;
}
