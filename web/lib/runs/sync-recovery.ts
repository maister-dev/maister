import "server-only";

import { and, desc, eq, notInArray } from "drizzle-orm";
import pino from "pino";

import { RELEASED_LIFECYCLE_CLAIM } from "@/lib/runs/lifecycle-claim";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { RUN_SYNC_TERMINAL_PHASES } from "@/lib/db/schema";
import { isBranchPublished } from "@/lib/runs/branch-published";
import { hasSyncDriver } from "@/lib/runs/sync-driver-registry";
import {
  SYNC_STEP_ID,
  teardownResolverSession,
} from "@/lib/runs/sync-resolver";
import {
  markSyncReviewFromNeedsInput,
  markSyncReviewFromRunning,
} from "@/lib/runs/state-transitions";
import { pushWithLease, verifySyncGate } from "@/lib/runs/sync-target";
import { poolForRunKind, promoteNextPending } from "@/lib/scheduler";
import {
  createExecutionHosts,
  type ExecutionHosts,
  type SupervisorSessionRecord,
} from "@/lib/execution-host";
import {
  abortSyncOperation,
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

type AttemptRow = {
  id: string;
  runId: string;
  workspaceId: string;
  phase: string;
  mode: string;
  headShaBefore: string | null;
  remoteShaBefore: string | null;
  agentRunningSince: Date | null;
  // The lifecycle slot's fence token AS OBSERVED when this attempt was loaded: a
  // separate uuid minted with the claim (NOT this row's id), readable only from
  // the workspace. `releaseClaim` fences on it so a pass can only free the claim
  // it actually saw — never one a newer sync has since taken.
  lifecycleAttemptId: string | null;
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
      lifecycleAttemptId: workspaces.lifecycleOperationAttemptId,
    })
    .from(runSyncAttempts)
    .innerJoin(workspaces, eq(workspaces.id, runSyncAttempts.workspaceId))
    .where(
      and(
        eq(runSyncAttempts.runId, runId),
        notInArray(
          runSyncAttempts.phase,
          RUN_SYNC_TERMINAL_PHASES as unknown as string[],
        ),
      ),
    )
    .orderBy(desc(runSyncAttempts.attempt))
    .limit(1);

  const row = rows[0];

  if (!row) return null;

  return {
    ...row,
    lifecycleAttemptId: (row.lifecycleAttemptId ?? null) as string | null,
  } as AttemptRow;
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

// Terminalize an attempt, but ONLY while it still sits on the phase this sweep
// observed. Every candidate here comes from a lock-free pre-read
// (`loadSweepCandidates` / `loadActiveAttempt`), and the W5 arm deliberately does
// not consult `hasSyncDriver` — the cap must be able to kill a LIVE in-process
// resolver — so these writes genuinely race that resolver's own finalize.
//
// The predicate is the EXACT observed phase, not `notInArray(TERMINAL_PHASES)`: a
// set guard still wins against a driver that has merely advanced (agent_running →
// pushing) and would let the sweep tear down a resolver mid-push. `false` means the
// row moved under us — the attempt is no longer ours and NO side effect may run.
async function casPhaseFailed(
  db: Db,
  attemptId: string,
  expectedPhase: string,
  errorCode: string,
  errorMessage: string,
): Promise<boolean> {
  const rows = await db
    .update(runSyncAttempts)
    .set({ phase: "failed", errorCode, errorMessage, updatedAt: new Date() })
    .where(
      and(
        eq(runSyncAttempts.id, attemptId),
        eq(runSyncAttempts.phase, expectedPhase),
      ),
    )
    .returning({ id: runSyncAttempts.id });

  return rows.length > 0;
}

async function casPhaseSucceeded(
  db: Db,
  attemptId: string,
  expectedPhase: string,
  extra: { headShaAfter: string; pushed: boolean },
): Promise<boolean> {
  const rows = await db
    .update(runSyncAttempts)
    .set({ phase: "succeeded", ...extra, updatedAt: new Date() })
    .where(
      and(
        eq(runSyncAttempts.id, attemptId),
        eq(runSyncAttempts.phase, expectedPhase),
      ),
    )
    .returning({ id: runSyncAttempts.id });

  return rows.length > 0;
}

// Free the shared lifecycle slot this attempt holds, FENCED on the slot's own
// attempt id (the token observed when this sweep loaded the candidate), so it is
// idempotent and can only ever release the claim it actually saw.
//
// A `lifecycle_operation_name='sync'` guard is NOT a fence — the twin
// `sync-target.ts#releaseSyncClaim` was fixed for exactly this: between load and
// write, this sweep's own recovery may free a stranded claim and a NEW sync take
// the slot; `name='sync'` still matches, so the release frees the new sync's
// claim out from under it, dropping the promotion fence mid-rebase. A null token
// means no claim is held — the fenced write then matches nothing, which is the
// correct no-op.
async function releaseClaim(
  db: Db,
  workspaceId: string,
  lifecycleAttemptId: string | null,
): Promise<void> {
  if (lifecycleAttemptId === null) return;

  await db
    .update(workspaces)
    .set(RELEASED_LIFECYCLE_CLAIM)
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.lifecycleOperationAttemptId, lifecycleAttemptId),
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
): Promise<boolean> {
  // CAS BEFORE the restore (claim-before-side-effect). `args.attempt` is a
  // lock-free pre-read, so the in-process resolver may have settled since — and a
  // settle can mean a LANDED push. `restoreWorktree` past that point resets the
  // local tree to pre-sync while origin keeps the resolved commit, which is the
  // divergence `sync-target.ts`'s `pushCommitted` flag exists to forbid. Losing the
  // CAS means the attempt is no longer ours and no side effect below may run.
  const won = await casPhaseFailed(
    db,
    args.attempt.id,
    args.attempt.phase,
    args.errorCode,
    args.errorMessage,
  );

  if (!won) return false;

  if (args.restore) {
    await restoreWorktree(args.ctx.worktree, args.attempt.headShaBefore);
  }
  await releaseClaim(
    db,
    args.attempt.workspaceId,
    args.attempt.lifecycleAttemptId,
  );
  await markSyncReviewFromRunning(args.attempt.runId, { db });
  await promoteNextPending({ db, pool: poolForRunKind(args.ctx.runKind) });

  return true;
}

export type ReconcileSyncOutcome = {
  window: "w2" | "w3";
  outcome: "aborted" | "finalized" | "noop";
};

/**
 * ADR-141 — the reconcile-side branch-sync recovery executor for the
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
  executionHosts?: ExecutionHosts;
  now?: () => Date;
}): Promise<ReconcileSyncOutcome> {
  const db = (args.db ?? getDb()) as Db;
  const now = args.now ?? (() => new Date());
  const hosts = args.executionHosts ?? createExecutionHosts({ db });
  const { runId } = args;

  const attempt = await loadActiveAttempt(db, runId);

  if (!attempt) {
    // A concurrent in-process finalize won the race and terminalized the attempt.
    return { window: args.liveSessionId ? "w2" : "w3", outcome: "noop" };
  }

  const ctx = await loadRunContext(db, runId);

  if (!ctx) {
    // No workspace — cannot act on git; just terminalize the ledger + claim.
    const won = await casPhaseFailed(
      db,
      attempt.id,
      attempt.phase,
      "CRASH",
      "sync recovery: run context gone",
    );

    if (!won) {
      return { window: args.liveSessionId ? "w2" : "w3", outcome: "noop" };
    }
    await releaseClaim(db, attempt.workspaceId, attempt.lifecycleAttemptId);

    return { window: args.liveSessionId ? "w2" : "w3", outcome: "aborted" };
  }

  // --- W2: an orphaned LIVE resolver session with no in-proc driver -----------
  if (args.liveSessionId) {
    await teardownResolverSession(hosts, runId, args.liveSessionId);
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
  // `ctx.branch` is REQUIRED here, exactly as on the live path. Recovery pushes
  // `refs/heads/<branch>` but measures HEAD: a crash that left HEAD DETACHED on
  // the resolution (e.g. the resolver ran `git rebase --quit`) leaves the branch
  // ref at its old commit. Without this argument every other check passes, the
  // push then no-ops against the stale branch, and the attempt records
  // `succeeded` with a `headShaAfter` that is not even reachable from it — a
  // sync reported as done while the PR stays unchanged.
  const gate = await verifySyncGate(ctx.worktree, targetSha, ctx.branch);

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
  const published = await isBranchPublished({
    prUrl: ctx.prUrl,
    repo: ctx.repo,
    branch: ctx.branch,
  }).catch(() => false);
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

  const settled = await casPhaseSucceeded(db, attempt.id, attempt.phase, {
    headShaAfter,
    pushed,
  });

  if (!settled) {
    // An in-process finalize terminalized this attempt between our pre-read and
    // here. It owns the ledger and the claim — leave both alone.
    return { window: "w3", outcome: "noop" };
  }
  if (attempt.headShaBefore && headShaAfter !== attempt.headShaBefore) {
    // HEAD moved (decision 13) — restart the auto-promotion grace window.
    await db
      .update(runs)
      .set({ reviewEnteredAt: now() })
      .where(eq(runs.id, runId));
  }
  await releaseClaim(db, attempt.workspaceId, attempt.lifecycleAttemptId);
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
  executionHosts?: ExecutionHosts;
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
      lifecycleAttemptId: workspaces.lifecycleOperationAttemptId,
    })
    .from(runSyncAttempts)
    .innerJoin(runs, eq(runs.id, runSyncAttempts.runId))
    .innerJoin(workspaces, eq(workspaces.id, runSyncAttempts.workspaceId))
    .where(
      notInArray(
        runSyncAttempts.phase,
        RUN_SYNC_TERMINAL_PHASES as unknown as string[],
      ),
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
      lifecycleAttemptId: (row.lifecycleAttemptId ?? null) as string | null,
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
 * ADR-141 — the system-sweep branch-sync recovery pass, run from
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
  const hosts = opts.executionHosts ?? createExecutionHosts({ db });

  const candidates = await loadSweepCandidates(db);

  if (candidates.length === 0) {
    return { candidates: 0, orphanOperationsAborted: 0, durationCapKilled: 0 };
  }

  // listSessions ONCE up front. On throw → skip the whole tick (never act on a
  // transient supervisor outage — the split-brain the keepalive/reconcile sweeps
  // also guard against).
  let records: SupervisorSessionRecord[];

  try {
    records = await hosts.local().listSessions();
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
      // CAS FIRST, on the EXACT observed phase. This arm deliberately does not
      // consult `hasSyncDriver` — the cap must be able to kill a LIVE in-process
      // resolver — so it races that resolver's own finalize, and `attempt` is a
      // lock-free pre-read. If the resolver has advanced to `verifying`/`pushing`
      // (or already settled), the CAS loses and we must not touch it: tearing down
      // a session mid-push, or restoring the worktree after the push LANDED, is the
      // divergence `sync-target.ts`'s `pushCommitted` flag forbids.
      const won = await casPhaseFailed(
        db,
        attempt.id,
        "agent_running",
        "CRASH",
        `sync resolver exceeded the ${SYNC_ATTEMPT_MAX_MINUTES}min active-time cap`,
      );

      if (!won) {
        log.info(
          { window: "w5", runId: attempt.runId, attempt: attempt.id },
          "sync recovery: resolver advanced or settled concurrently — cap kill skipped",
        );

        continue;
      }

      const live = liveSyncSessionFor(records, attempt.runId);

      if (live) {
        await teardownResolverSession(hosts, attempt.runId, live.sessionId);
      }
      await restoreWorktree(cand.worktree, attempt.headShaBefore);
      await releaseClaim(db, attempt.workspaceId, attempt.lifecycleAttemptId);
      await markSyncReviewFromRunning(attempt.runId, { db });
      await promoteNextPending({ db, pool: poolForRunKind(cand.runKind) });
      durationCapKilled += 1;
      log.warn(
        { window: "w5", runId: attempt.runId, attempt: attempt.id },
        "sync recovery: killed runaway resolver past active-time cap, returned run to Review",
      );

      continue;
    }

    // W7: an agent resolver PARKED ON HITL whose driver is gone. This is where
    // the resolver waits BY DESIGN — an ACP `requestPermission` moves the run to
    // `NeedsInput` — so post-restart the prompt has no one to answer it: W5 is
    // `Running`-only, reconcile owns only `Running`, and the W1/W4 arm below is
    // `mechanical`-only. Left unswept the run holds a pool slot AND the sync
    // claim forever (which also refuses promote and every other lifecycle op).
    if (
      attempt.phase === "agent_running" &&
      (cand.runStatus === "NeedsInput" ||
        cand.runStatus === "NeedsInputIdle") &&
      !hasSyncDriver(attempt.runId)
    ) {
      // CAS the phase FIRST, on the exact observed value: a resume racing this
      // sweep flips the run back to `Running` and drives on, and the loser must
      // not tear that session down mid-flight.
      const won = await casPhaseFailed(
        db,
        attempt.id,
        "agent_running",
        "CRASH",
        "sync resolver orphaned while parked on a HITL prompt",
      );

      if (!won) {
        log.info(
          { window: "w7", runId: attempt.runId, attempt: attempt.id },
          "sync recovery: resolver advanced or settled concurrently — orphan abort skipped",
        );

        continue;
      }

      const live = liveSyncSessionFor(records, attempt.runId);

      if (live) {
        await teardownResolverSession(hosts, attempt.runId, live.sessionId);
      }
      await restoreWorktree(cand.worktree, attempt.headShaBefore);
      await releaseClaim(db, attempt.workspaceId, attempt.lifecycleAttemptId);
      await markSyncReviewFromNeedsInput(attempt.runId, cand.runStatus, { db });
      await promoteNextPending({ db, pool: poolForRunKind(cand.runKind) });
      orphanOperationsAborted += 1;
      log.warn(
        { window: "w7", runId: attempt.runId, attempt: attempt.id },
        "sync recovery: aborted an orphaned resolver parked on HITL, returned run to Review",
      );

      continue;
    }

    // W1/W4: a MECHANICAL sync orphaned by a restart — no in-proc driver owns it.
    // A live in-flight mechanical sync in THIS process IS registered, so
    // `hasSyncDriver` excludes it (the skip-vs-abort discriminant).
    //
    // EVERY non-terminal mechanical phase must reach this arm. The mechanical
    // driver writes starting → rebasing → verifying → pushing, and a mechanical
    // sync never leaves `Review` — so reconcile, which only owns `Running` rows,
    // never classifies it, and every other `releaseSyncClaim` lives in
    // `sync-target.ts` and dies with the process. This is its ONLY cross-restart
    // release: a phase omitted here strands `lifecycle_operation_state='claiming'`
    // forever, permanently refusing promote AND all six lifecycle ops with no exit
    // but DB surgery. `loadSweepCandidates` already filters terminal phases, and
    // `mode === "mechanical"` excludes `agent_running`, so the phase list is
    // exactly "whatever is left" — never re-enumerate it here.
    if (cand.attempt.mode === "mechanical" && !hasSyncDriver(attempt.runId)) {
      // `pushing` is past the point of no return: `pushWithLease` may have LANDED
      // before the crash and nothing records that durably, so the two outcomes need
      // OPPOSITE recoveries. Ask origin. Restoring after a landed push resets the
      // local tree to pre-sync while origin (and its PR) keep the rebased commit —
      // manufacturing the divergence `sync-target.ts`'s `pushCommitted` flag exists
      // to forbid. Phases below `pushing` are local-only and safe to abort.
      let landedHeadSha: string | null = null;

      if (attempt.phase === "pushing") {
        const pushCtx = await loadRunContext(db, attempt.runId);
        const head = await headCommit({ worktreePath: cand.worktree }).catch(
          () => null,
        );
        const remoteHead = pushCtx
          ? await remoteBranchHead({
              projectRepoPath: pushCtx.repo,
              remote: "origin",
              branch: pushCtx.branch,
            }).catch(() => null)
          : null;

        if (
          head &&
          remoteHead &&
          remoteHead.toLowerCase() === head.toLowerCase()
        ) {
          landedHeadSha = head;
        }
      }

      if (landedHeadSha) {
        const settled = await casPhaseSucceeded(db, attempt.id, attempt.phase, {
          headShaAfter: landedHeadSha,
          pushed: true,
        });

        if (settled) {
          await releaseClaim(
            db,
            attempt.workspaceId,
            attempt.lifecycleAttemptId,
          );
          orphanOperationsAborted += 1;
          log.warn(
            {
              window: "w4b",
              runId: attempt.runId,
              attempt: attempt.id,
              headShaAfter: landedHeadSha,
            },
            "sync recovery: orphaned mechanical push had already LANDED — settled forward, released claim",
          );
        }

        continue;
      }

      const won = await casPhaseFailed(
        db,
        attempt.id,
        attempt.phase,
        "CRASH",
        "mechanical sync orphaned by restart (no in-proc driver)",
      );

      if (!won) continue;

      // Never restore out of `pushing`: an unproven push is not a missed push (the
      // origin read may simply have failed), and the live path's own lease-rejected
      // branch KEEPS the local rebase rather than restoring it.
      if (attempt.phase !== "pushing") {
        await restoreWorktree(cand.worktree, attempt.headShaBefore);
      }
      await releaseClaim(db, attempt.workspaceId, attempt.lifecycleAttemptId);
      orphanOperationsAborted += 1;
      log.warn(
        {
          window: attempt.phase === "starting" ? "w1" : "w4",
          phase: attempt.phase,
          runId: attempt.runId,
          attempt: attempt.id,
          restored: attempt.phase !== "pushing",
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
