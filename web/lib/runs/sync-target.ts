import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, notInArray, sql } from "drizzle-orm";
import pino from "pino";

import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { resolveSyncRunner } from "@/lib/acp-runners/resolve";
import {
  runnerExecutorInput,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { isExperimentMemberRun } from "@/lib/experiments/membership";
import { promotionClaimTimeoutSeconds } from "@/lib/instance-config";
import {
  markSyncFromReview,
  markSyncReviewFromRunning,
} from "@/lib/runs/state-transitions";
import {
  registerSyncDriver,
  unregisterSyncDriver,
} from "@/lib/runs/sync-driver-registry";
import {
  buildResolverPrompt,
  runResolverSession,
  SYNC_STEP_ID,
} from "@/lib/runs/sync-resolver";
import {
  capForPool,
  countLiveRuns,
  poolForRunKind,
  promoteNextPending,
  takeSchedulerLock,
  type SchedulerPool,
} from "@/lib/scheduler";
import {
  deleteSession,
  type CreateSessionInput,
  type PromptStopReason,
} from "@/lib/supervisor-client";
import {
  aheadBehindCounts,
  currentBranchName,
  branchHasUpstream,
  abortSyncOperation,
  fetchRemote,
  ffUpdateLocalBranch,
  forceWithLeasePush,
  getRemoteUrl,
  hasConflictMarkers,
  headCommit,
  localBranchHead,
  mergeFromRef,
  rebaseOntoRef,
  remoteBranchHead,
  remoteTrackingBranchHead,
  restoreWorktreeToCommit,
  statusPorcelain,
  syncOperationInProgress,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants — mirror promote.ts's bridge.
const {
  runs,
  workspaces,
  projects,
  tasks,
  runSyncAttempts,
  runSessions,
  platformRuntimeSettings,
} = schemaModule as unknown as Record<string, any>;

// FIXME(any): the injected db seam is a Drizzle client OR a Testcontainers pg
// client; both expose select/insert/update/transaction.
type Db = any;

const log = pino({
  name: "sync-target",
  level: process.env.LOG_LEVEL ?? "info",
});

const TERMINAL_PHASES = ["succeeded", "failed", "aborted"] as const;

export type SyncStrategy = "rebase" | "merge";

export type SyncActor = {
  type: "user" | "agent" | "system";
  id: string | null;
};

export type SyncRunOutcome = {
  attemptId: string;
  outcome: "noop" | "synced" | "conflict" | "agent_launched";
  behind: number;
  pushed: boolean;
};

export type SyncRunInput = {
  runId: string;
  strategy?: SyncStrategy;
  // ADR-140: on a conflict the AI resolver launches by DEFAULT
  // (`outcome:"agent_launched"`) — the contract default is agent-on (matches
  // the OpenAPI `agent` "(default)" and the UI "resolve with AI" checkbox
  // default ON). ONLY an explicit `agent:false` keeps the mechanical behavior:
  // a clean abort restoring the pre-sync SHA (`outcome:"conflict"`).
  agent?: boolean;
  push?: boolean;
  runnerId?: string;
  // ADR-140 (Task 13): set by the resolver-backed `ai_rebase_merge` promotion.
  // Persisted on the attempt; on a verified agent resolution the resolver
  // best-effort chains `promoteRun(rebase_merge)` to Done (default OFF).
  autoFinalize?: boolean;
  actor: SyncActor;
  db?: Db;
  now?: () => Date;
};

export type SyncEligibilityRun = {
  status: string;
  runKind: string;
  parentRunId: string | null;
  workspaceMode: string | null;
  isExperimentMember: boolean;
};

type Claim = {
  attemptId: string;
  attempt: number;
  workspaceId: string;
  // The shared lifecycle slot's own fence token (`workspaces.
  // lifecycle_operation_attempt_id`), NOT the sync attempt id. It identifies
  // THIS claim of the slot, so the release and the lease heartbeat can both
  // refuse to touch a slot that is no longer ours.
  lifecycleAttemptId: string;
};

// Beat the lease this many times per reclaim window. Derived rather than fixed
// so tuning MAISTER_PROMOTION_CLAIM_TIMEOUT_SECONDS down cannot silently make
// the heartbeat slower than the window it defends.
const CLAIM_HEARTBEAT_BEATS_PER_WINDOW = 4;

function claimHeartbeatMs(): number {
  return Math.max(
    1_000,
    Math.floor(
      (promotionClaimTimeoutSeconds() * 1_000) /
        CLAIM_HEARTBEAT_BEATS_PER_WINDOW,
    ),
  );
}

// The shared readiness contract Task 9 needs from a run row + its workspace. A
// sync targets exactly a top-level, non-shared, non-experiment Review flow/agent
// run whose worktree is still present.
export function assertSyncEligible(
  run: SyncEligibilityRun,
  workspace: { removedAt: Date | null },
): void {
  if (run.status !== "Review") {
    throw new MaisterError(
      "PRECONDITION",
      `run must be Review to sync (is ${run.status})`,
    );
  }
  if (run.runKind !== "flow" && run.runKind !== "agent") {
    throw new MaisterError(
      "PRECONDITION",
      `only flow and agent runs can sync (is ${run.runKind})`,
    );
  }
  if (run.parentRunId !== null) {
    throw new MaisterError(
      "PRECONDITION",
      "an orchestrator child run cannot sync its branch",
    );
  }
  if (run.workspaceMode === "shared") {
    throw new MaisterError(
      "PRECONDITION",
      "a shared-tree run cannot sync — the tree is one branch",
    );
  }
  if (run.isExperimentMember) {
    throw new MaisterError(
      "PRECONDITION",
      "an experiment-member run cannot sync — conclude the experiment first",
    );
  }
  if (workspace.removedAt !== null) {
    throw new MaisterError(
      "PRECONDITION",
      "the run workspace was removed — nothing to sync",
    );
  }
}

// Decision-10 post-apply gate (reusable by the Task 10 resolver + Task 13). A
// synced HEAD is promotable only when nothing is mid-flight, the tree is clean,
// there are no leftover conflict markers, and the target is an ancestor of HEAD.
// `branch` is REQUIRED, deliberately. It was optional once, and the recovery
// call site simply omitted it — silently losing the detached-HEAD guard on the
// exact path (crash recovery) where a detached HEAD is most likely. A required
// parameter makes the compiler enforce that sweep: a new caller cannot forget it.
export async function verifySyncGate(
  worktree: string,
  targetSha: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (await syncOperationInProgress(worktree)) {
    return { ok: false, reason: "a rebase or merge is still in progress" };
  }
  if ((await statusPorcelain({ worktreePath: worktree })).trim() !== "") {
    return { ok: false, reason: "the worktree is not clean" };
  }
  // The gate measures HEAD, but the push pushes `refs/heads/<branch>`. A resolver
  // that ends a conflicted rebase with `git rebase --quit` leaves HEAD DETACHED on
  // its resolution while the branch ref still sits at the old tip — every other
  // check would then pass against a commit the push does not carry.
  const head = await currentBranchName(worktree);

  if (head !== branch) {
    return {
      ok: false,
      reason: `HEAD is not on ${branch} (detached or switched) — the push would not carry the verified commit`,
    };
  }
  // Markers are checked over the COMMITTED range: the tree is provably clean by
  // now, so a working-tree check could never see a marker the resolver COMMITTED.
  if (await hasConflictMarkers(worktree, targetSha)) {
    return { ok: false, reason: "leftover conflict markers remain" };
  }
  // aheadBehindCounts(base=target, ref=HEAD).behind === 0 ⇔ target ⊆ HEAD ⇔ the
  // target is an ancestor of the synced HEAD.
  const { ahead, behind } = await aheadBehindCounts(
    worktree,
    targetSha,
    "HEAD",
  );

  if (behind !== 0) {
    return {
      ok: false,
      reason: "the target is not an ancestor of the synced HEAD",
    };
  }
  // The run's OWN work must survive the sync. `git rebase --skip` (which git's own
  // conflict hint suggests) drops the conflicting commit; skipping every commit
  // leaves the branch identical to the target and passes every check above, so the
  // force-push would erase the user's committed work from the branch and its PR.
  if (ahead === 0) {
    return {
      ok: false,
      reason:
        "the sync left the branch identical to the target — the run's own commits would be erased",
    };
  }

  return { ok: true };
}

// Explicit-SHA force-with-lease push. A lease rejection (the remote moved off
// `remoteShaBefore`) resolves structurally — the caller maps it to a typed
// CONFLICT and keeps the local rebase. Reusable by the Task 10 resolver finalize.
export async function pushWithLease(
  worktree: string,
  branch: string,
  remoteShaBefore: string | null,
): Promise<{ pushed: true } | { pushed: false; leaseFailed: true }> {
  return forceWithLeasePush({
    worktreePath: worktree,
    branch,
    expectedSha: remoteShaBefore,
  });
}

async function loadRun(db: Db, runId: string): Promise<any> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));

  if (!rows[0]) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }

  return rows[0];
}

async function loadWorkspace(db: Db, runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.runId, runId));

  if (!rows[0]) {
    throw new MaisterError("PRECONDITION", `workspace not found: ${runId}`);
  }

  return rows[0];
}

async function loadWorkspaceForUpdate(tx: Db, runId: string): Promise<any> {
  const rows = await tx
    .select()
    .from(workspaces)
    .where(eq(workspaces.runId, runId))
    .for("update");

  if (!rows[0]) {
    throw new MaisterError("PRECONDITION", `workspace not found: ${runId}`);
  }

  return rows[0];
}

async function loadProject(db: Db, projectId: string | null): Promise<any> {
  if (!projectId) return null;
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));

  return rows[0] ?? null;
}

async function setAttemptPhase(
  db: Db,
  attemptId: string,
  phase: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db
    .update(runSyncAttempts)
    .set({ phase, updatedAt: new Date(), ...extra })
    .where(eq(runSyncAttempts.id, attemptId));
}

// Free the shared lifecycle slot this attempt holds. Fenced on the slot's OWN
// attempt id, so it is idempotent (a second call after the slot is freed matches
// no row) and can only ever release the claim it took. The previous
// `lifecycle_operation_name='sync'` guard was not a fence: once recovery has
// released a stranded claim and a NEW sync has taken the slot, the zombie
// driver's release still matched `name='sync'` and freed the new sync's claim
// out from under it, dropping the promotion fence mid-rebase.
async function releaseSyncClaim(db: Db, claim: Claim): Promise<void> {
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
        eq(workspaces.id, claim.workspaceId),
        eq(workspaces.lifecycleOperationAttemptId, claim.lifecycleAttemptId),
      ),
    );
}

// The in-process driver's liveness, acquired as ONE handle because the registry
// membership and the claim lease share exactly one lifetime and exactly one
// owner. Returns the sole release; call it once, from whoever owns the driver at
// that moment (see the ownership handoff in `syncRunTarget`).
//
// The heartbeat exists because the lifecycle claim is a LEASE:
// `canReclaimLifecycle` (workbench-lifecycle/service.ts) treats any `claiming`
// slot whose `claimed_at` is older than `promotionClaimTimeoutSeconds()`
// (default 300s) as crashed, and steals it. A sync legitimately outlives that
// window by a wide margin — a mechanical rebase can be slow, and a resolver's
// `agent_running_since` is RE-STAMPED on every HITL resume, so one waiting on a
// human holds the slot for hours. A steal overwrites
// `lifecycle_operation_name='sync'`, which is the exact predicate promote's
// reverse fence keys on, so promotion would then `git merge` a branch mid-rebase.
// Beating `claimed_at` makes the column mean "last known alive" — which is what
// the reclaim window already assumes it means — so a live sync is never stolen
// and a dead one still self-heals after the window. This is a lease renewal, not
// polling for a state transition.
export function acquireSyncDriver(
  db: Db,
  runId: string,
  claim: Claim,
): () => void {
  registerSyncDriver(runId);

  const timer: NodeJS.Timeout = setInterval(() => {
    void db
      .update(workspaces)
      .set({ lifecycleOperationClaimedAt: new Date() })
      .where(
        and(
          eq(workspaces.id, claim.workspaceId),
          eq(workspaces.lifecycleOperationAttemptId, claim.lifecycleAttemptId),
        ),
      )
      .catch((err: unknown) => {
        log.warn(
          {
            runId,
            attemptId: claim.attemptId,
            err: err instanceof Error ? err.message : String(err),
          },
          "sync lifecycle-claim heartbeat failed — the claim may be reclaimed as stale",
        );
      });
  }, claimHeartbeatMs());

  timer.unref?.();

  return () => {
    clearInterval(timer);
    unregisterSyncDriver(runId);
  };
}

// Terminal write for a `noop`/`synced` attempt: record the phase (+ pushed /
// head_sha_after), reset `runs.review_entered_at` ONLY when HEAD moved
// (decision 13 — restart the auto-promotion grace window), then release the claim.
async function settleAttempt(
  db: Db,
  claim: Claim,
  args: {
    runId: string;
    headMoved: boolean;
    headShaAfter?: string;
    pushed?: boolean;
    now: () => Date;
  },
): Promise<void> {
  await setAttemptPhase(db, claim.attemptId, "succeeded", {
    ...(args.headShaAfter !== undefined
      ? { headShaAfter: args.headShaAfter }
      : {}),
    ...(args.pushed !== undefined ? { pushed: args.pushed } : {}),
  });
  if (args.headMoved) {
    await db
      .update(runs)
      .set({ reviewEnteredAt: args.now() })
      .where(eq(runs.id, args.runId));
  }
  await releaseSyncClaim(db, claim);
}

// Terminal write for an aborted attempt (divergence / clean conflict abort):
// record `aborted`, then release the claim. No run mutation — status stays Review.
async function abortAttempt(
  db: Db,
  claim: Claim,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await setAttemptPhase(db, claim.attemptId, "aborted", extra);
  await releaseSyncClaim(db, claim);
}

// Terminal write for a failed attempt (verify-fail / lease-fail): record `failed`
// + error, then release the claim. The local rebase result is left untouched.
async function failAttempt(
  db: Db,
  claim: Claim,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await setAttemptPhase(db, claim.attemptId, "failed", {
    errorCode,
    errorMessage,
  });
  await releaseSyncClaim(db, claim);
}

// Safety net for an UNHANDLED throw between the claim commit and an explicit
// terminal: mark the attempt failed ONLY if still non-terminal (never overwrite an
// explicit `aborted`/`succeeded`/`failed`) and release the claim (idempotent).
async function terminalizeSafetyNet(
  db: Db,
  claim: Claim,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const code = isMaisterError(err) ? err.code : "CRASH";

  await db
    .update(runSyncAttempts)
    .set({
      phase: "failed",
      errorCode: code,
      errorMessage: message,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(runSyncAttempts.id, claim.attemptId),
        notInArray(
          runSyncAttempts.phase,
          TERMINAL_PHASES as unknown as string[],
        ),
      ),
    );
  await releaseSyncClaim(db, claim);
}

/**
 * The MECHANICAL branch-sync service (ADR-140, Task 9) — and the reusable shared
 * core (`assertSyncEligible` / `verifySyncGate` / `pushWithLease`) Tasks 10/13
 * build on. Rebases (or merges) a Review run's branch onto its promotion target
 * inside the run's worktree, fast-forwarding the local target from origin first,
 * and force-with-lease pushing when the branch is published. Concurrency is the
 * keystone: the claim runs in ONE `FOR UPDATE` transaction that mints exactly one
 * `run_sync_attempts` row and takes the shared workspace lifecycle slot, so a
 * double-launch serializes and the loser is refused CONFLICT. The double fence
 * makes sync mutually exclusive with promotion (both directions) and every other
 * lifecycle op.
 */
export async function syncRunTarget(
  input: SyncRunInput,
): Promise<SyncRunOutcome> {
  const db = (input.db ?? getDb()) as Db;
  const now = input.now ?? (() => new Date());
  const { runId } = input;

  // 1. Load + eligibility + dirty-tree refusal (all BEFORE any claim).
  const run = await loadRun(db, runId);
  const workspace = await loadWorkspace(db, runId);
  const isExperimentMember = await isExperimentMemberRun(db, runId);

  assertSyncEligible(
    {
      status: run.status,
      runKind: run.runKind,
      parentRunId: run.parentRunId ?? null,
      workspaceMode: run.workspaceMode ?? null,
      isExperimentMember,
    },
    workspace,
  );

  const project = await loadProject(db, run.projectId ?? null);
  const repo = workspace.parentRepoPath as string;
  const worktree = workspace.worktreePath as string;
  const branch = workspace.branch as string;
  const targetBranch =
    (workspace.targetBranch as string | null) ?? project?.mainBranch ?? "main";
  const strategy: SyncStrategy =
    input.strategy ?? project?.syncStrategyDefault ?? "rebase";

  if ((await statusPorcelain({ worktreePath: worktree })).trim() !== "") {
    throw new MaisterError(
      "PRECONDITION",
      `worktree has uncommitted changes — snapshot-commit before syncing run ${runId}`,
    );
  }

  // 2. Capture remoteShaBefore BEFORE any fetch — the explicit-SHA lease authority
  //    (so a later all-refs fetch cannot move the lease out from under us). Only a
  //    published branch is ever pushed, so only it needs the network read.
  const published =
    workspace.prUrl != null || (await branchHasUpstream(repo, branch));
  let remoteShaBefore: string | null = null;
  let remoteShaIndeterminate = false;

  if (published) {
    try {
      remoteShaBefore = await remoteBranchHead({
        projectRepoPath: repo,
        remote: "origin",
        branch,
      });
    } catch {
      // Could not read the remote head — record it; the eventual push refuses.
      remoteShaIndeterminate = true;
    }
  }

  // 3. THE CLAIM (one FOR UPDATE tx): double fence + attempt allocation + slot.
  const claim: Claim = await db.transaction(async (tx: Db) => {
    const ws = await loadWorkspaceForUpdate(tx, runId);

    // (a) promotion↔sync fence — a promotion in progress or already done blocks a
    // sync. `reopened` is neither, so a reopened run passes through (Task 13).
    if (ws.promotionState === "claiming" || ws.promotionState === "done") {
      throw new MaisterError(
        "CONFLICT",
        `a promotion is ${ws.promotionState} for run ${runId} — cannot sync`,
      );
    }
    // (b) a competing active lifecycle claim (archive/drop/…/another sync).
    if (ws.lifecycleOperationState === "claiming") {
      throw new MaisterError(
        "CONFLICT",
        `a lifecycle operation is already in progress for run ${runId}`,
      );
    }

    // (c) attempt = max(attempt)+1 for this run.
    const attemptRows = await tx
      .select({
        maxAttempt: sql<number>`coalesce(max(${runSyncAttempts.attempt}), 0)`,
      })
      .from(runSyncAttempts)
      .where(eq(runSyncAttempts.runId, runId));
    const attempt = Number(attemptRows[0].maxAttempt) + 1;
    const attemptId = randomUUID();

    // (d) the attempt row, phase 'starting'.
    await tx.insert(runSyncAttempts).values({
      id: attemptId,
      runId,
      workspaceId: ws.id,
      attempt,
      strategy,
      mode: "mechanical",
      phase: "starting",
      targetRef: targetBranch,
      remoteShaBefore,
      runnerId: input.runnerId ?? null,
      autoFinalize: input.autoFinalize ?? false,
      actorType: input.actor.type,
      actorId: input.actor.id,
    });

    // (e) take the shared workspace lifecycle slot as `sync`. The attempt id is
    // the slot's fence token — kept, not thrown away: the release and the lease
    // heartbeat both predicate on it so neither can touch a slot we no longer own.
    const lifecycleAttemptId = randomUUID();

    await tx
      .update(workspaces)
      .set({
        lifecycleOperationState: "claiming",
        lifecycleOperationClaimedAt: now(),
        lifecycleOperationAttemptId: lifecycleAttemptId,
        lifecycleOperationName: "sync",
      })
      .where(eq(workspaces.id, ws.id));

    log.debug({ runId, attemptId, attempt, strategy }, "sync claim minted");

    return { attemptId, attempt, workspaceId: ws.id, lifecycleAttemptId };
  });

  // ADR-140 (Task 11): THIS call is the in-process sync driver — for the
  // mechanical rebase AND, transitively, the agent resolver it awaits below.
  // Acquisition MUST live here, not in the resolver: the recovery sweeps treat a
  // non-terminal attempt with no registered driver as a post-restart ORPHAN and
  // abort it (restore + release claim). Registering only around the resolver left
  // every live MECHANICAL sync looking orphaned, so a sweep tick landing mid-rebase
  // would `git rebase --abort` under it and release the claim while it ran.
  // The registry is a plain Set (not refcounted) — acquire in exactly ONE place.
  const releaseDriver = acquireSyncDriver(db, runId, claim);

  try {
    // 4. Fetch the target and fast-forward the LOCAL target from origin/<target>.
    //    Skipped for a purely local repo (no origin).
    const hasOrigin =
      (await getRemoteUrl({ projectRepoPath: repo, name: "origin" })) !== null;

    if (hasOrigin) {
      await fetchRemote({ projectRepoPath: repo, name: "origin" });
      const targetRemoteSha = await remoteTrackingBranchHead({
        projectRepoPath: repo,
        remote: "origin",
        branch: targetBranch,
      });

      if (targetRemoteSha) {
        const localTargetHead = await localBranchHead({
          projectRepoPath: repo,
          branch: targetBranch,
        });

        try {
          await ffUpdateLocalBranch(repo, targetBranch, targetRemoteSha);
        } catch (err) {
          if (isMaisterError(err) && err.code === "PRECONDITION") {
            await abortAttempt(db, claim);
            throw new MaisterError(
              "PRECONDITION",
              `local target '${targetBranch}' diverged from origin — local ${localTargetHead} is not fast-forwardable to ${targetRemoteSha}; reconcile the target branch first`,
            );
          }
          throw err;
        }
      }
    }

    // 5. behind===0 → no-op (run stays Review, no push).
    const { behind } = await aheadBehindCounts(repo, targetBranch, branch);

    if (behind === 0) {
      await settleAttempt(db, claim, { runId, headMoved: false, now });
      log.info(
        { runId, attemptId: claim.attemptId },
        "sync no-op — already up to date",
      );

      return {
        attemptId: claim.attemptId,
        outcome: "noop",
        behind: 0,
        pushed: false,
      };
    }

    // 6. Apply.
    const headShaBefore = await headCommit({ worktreePath: worktree });

    await setAttemptPhase(db, claim.attemptId, "rebasing", { headShaBefore });

    const applied =
      strategy === "merge"
        ? await mergeFromRef(worktree, targetBranch)
        : await rebaseOntoRef(worktree, targetBranch);

    // 8. Conflict. The AI resolver launches by DEFAULT against the LEFT-in-place
    //    conflicted rebase (contract default agent-on); ONLY explicit
    //    `agent:false` aborts cleanly (rebase/merge --abort restores the
    //    pre-sync HEAD) and returns `conflict`.
    if (!applied.ok) {
      if (input.agent !== false) {
        return await runSyncResolver({
          db,
          now,
          claim,
          runId,
          runKind: run.runKind as string,
          taskId: (run.taskId as string | null) ?? null,
          project,
          worktree,
          repo,
          branch,
          targetBranch,
          strategy,
          behind,
          conflictedFiles: applied.conflictedFiles,
          headShaBefore,
          published,
          remoteShaBefore,
          remoteShaIndeterminate,
          push: input.push,
          runnerId: input.runnerId,
          autoFinalize: input.autoFinalize ?? false,
          actor: input.actor,
        });
      }

      await abortSyncOperation(worktree);
      await abortAttempt(db, claim, {
        conflictedFiles: applied.conflictedFiles,
      });
      log.info(
        {
          runId,
          attemptId: claim.attemptId,
          conflicted: applied.conflictedFiles.length,
        },
        "sync conflict — aborted (agent=false)",
      );

      return {
        attemptId: claim.attemptId,
        outcome: "conflict",
        behind,
        pushed: false,
      };
    }

    // 7. Clean apply → verify gate → decide push → succeed.
    await setAttemptPhase(db, claim.attemptId, "verifying");
    const targetSha = await localBranchHead({
      projectRepoPath: repo,
      branch: targetBranch,
    });
    const gate = await verifySyncGate(
      worktree,
      targetSha ?? targetBranch,
      branch,
    );

    if (!gate.ok) {
      // Defensively unreachable after a clean rebase (clean tree, no markers,
      // target is an ancestor). abortSyncOperation is a no-op here; status stays
      // Review.
      await abortSyncOperation(worktree);
      await failAttempt(
        db,
        claim,
        "PRECONDITION",
        `verify gate failed: ${gate.reason}`,
      );
      throw new MaisterError(
        "PRECONDITION",
        `sync verification failed: ${gate.reason}`,
      );
    }

    const headShaAfter = await headCommit({ worktreePath: worktree });
    const headMoved = headShaAfter !== headShaBefore;
    const shouldPush = input.push ?? published;
    let pushed = false;

    if (shouldPush) {
      if (published && remoteShaIndeterminate) {
        await failAttempt(
          db,
          claim,
          "CONFLICT",
          `could not determine origin/${branch} before fetch — push refused (local rebase kept)`,
        );
        throw new MaisterError(
          "CONFLICT",
          `could not determine the remote head of ${branch} — push refused; the local rebase is kept, retry the sync`,
        );
      }

      await setAttemptPhase(db, claim.attemptId, "pushing");
      const push = await pushWithLease(worktree, branch, remoteShaBefore);

      if (!push.pushed) {
        await failAttempt(
          db,
          claim,
          "CONFLICT",
          `force-with-lease rejected — ${branch} moved on origin (expected ${remoteShaBefore}); local rebase kept`,
        );
        throw new MaisterError(
          "CONFLICT",
          `force-with-lease push rejected — ${branch} moved on origin; the local rebase result is kept, retry the sync`,
        );
      }
      pushed = true;
    }

    await settleAttempt(db, claim, {
      runId,
      headMoved,
      headShaAfter,
      pushed,
      now,
    });
    log.info(
      { runId, attemptId: claim.attemptId, behind, pushed, headMoved },
      "sync synced",
    );

    return { attemptId: claim.attemptId, outcome: "synced", behind, pushed };
  } catch (err) {
    // Safety net: the explicit terminal sites above already released + terminalized
    // (idempotent no-ops here); this only fires for an UNHANDLED throw so no path
    // leaves a dangling `claiming` slot or a non-terminal attempt.
    await abortSyncOperation(worktree).catch(() => undefined);
    await terminalizeSafetyNet(db, claim, err);
    throw err;
  } finally {
    // The driver is off the stack: any non-terminal attempt left behind IS now a
    // real orphan, and the sweeps must be free to abort it.
    releaseDriver();
  }
}

async function loadTask(
  db: Db,
  taskId: string,
): Promise<{ title: string | null; prompt: string | null } | null> {
  const rows = await db
    .select({ title: tasks.title, prompt: tasks.prompt })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  return rows[0]
    ? { title: rows[0].title ?? null, prompt: rows[0].prompt ?? null }
    : null;
}

async function platformDefaultRunnerId(db: Db): Promise<string | null> {
  const rows = await db
    .select({ defaultRunnerId: platformRuntimeSettings.defaultRunnerId })
    .from(platformRuntimeSettings)
    .where(eq(platformRuntimeSettings.id, "singleton"));

  return rows[0]?.defaultRunnerId ?? null;
}

// The resolver failure restore (crash / non-`end_turn` / verify-fail / lease-fail
// / push-refused): restore the pre-sync HEAD, mark the attempt `failed` + release
// the claim, CAS the run back to Review, and free the pool slot. The caller has
// already torn the supervisor session down (deferred-release).
async function failResolver(args: {
  db: Db;
  claim: Claim;
  runId: string;
  worktree: string;
  headShaBefore: string;
  pool: SchedulerPool;
  errorCode: string;
  errorMessage: string;
}): Promise<void> {
  // Classified failure only (code + message) — NEVER prompt/output content.
  log.error(
    {
      runId: args.runId,
      attemptId: args.claim.attemptId,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
    },
    "sync resolver failed — restoring pre-sync HEAD, returning run to Review",
  );
  await restoreWorktreeToCommit(args.worktree, args.headShaBefore).catch(
    (err: unknown) => {
      log.error(
        {
          runId: args.runId,
          err: err instanceof Error ? err.message : String(err),
        },
        "sync resolver restore-to-pre-sync-HEAD failed",
      );
    },
  );
  await failAttempt(args.db, args.claim, args.errorCode, args.errorMessage);
  await markSyncReviewFromRunning(args.runId, { db: args.db });
  await promoteNextPending({ db: args.db, pool: args.pool });
}

type SyncResolverArgs = {
  db: Db;
  now: () => Date;
  claim: Claim;
  runId: string;
  runKind: string;
  taskId: string | null;
  project: any;
  worktree: string;
  repo: string;
  branch: string;
  targetBranch: string;
  strategy: SyncStrategy;
  behind: number;
  conflictedFiles: string[];
  headShaBefore: string;
  published: boolean;
  remoteShaBefore: string | null;
  remoteShaIndeterminate: boolean;
  push?: boolean;
  runnerId?: string;
  autoFinalize?: boolean;
  actor: SyncActor;
};

/**
 * The AI conflict resolver (ADR-140, Task 10). Called from `syncRunTarget`'s
 * conflict branch with `agent:true` and the LEFT-in-place conflicted rebase. It
 * cap-gates + fences + flips `Review→Running` (one locked tx), spawns a FRESH
 * resolver session in the worktree (mocked at the supervisor boundary in tests),
 * drives one blocking turn, then applies the SAME Task-9 verify gate + push policy
 * before finalizing back to `Review`. Every path after a spawned session tears it
 * down (deferred-release). Slots are released via `promoteNextPending` on finalize.
 */
async function runSyncResolver(
  args: SyncResolverArgs,
): Promise<SyncRunOutcome> {
  const {
    db,
    now,
    claim,
    runId,
    worktree,
    repo,
    branch,
    targetBranch,
    strategy,
    behind,
    conflictedFiles,
    headShaBefore,
  } = args;
  const pool = poolForRunKind(args.runKind);

  // --- Pre-session: cap gate + runner resolution + Review→Running (one tx) ---
  // Everything that can throw runs BEFORE the run is live (or inside the CAS tx),
  // so a pre-session failure is always a clean abort — nothing strands `Running`.
  let sessionInput: CreateSessionInput;
  let runnerTier: string;
  let prompt: string;

  try {
    // (1) Fail-fast cap check (decision 15) — refuse CONFLICT at cap, no queue.
    await assertPoolCapacity(db, pool);

    // (2) Resolve the sync runner: launch override → sync default → project →
    //     platform (flow tiers do not participate).
    if (!args.project) {
      throw new MaisterError(
        "PRECONDITION",
        `run ${runId} has no project — cannot resolve a sync runner`,
      );
    }
    const runners = await loadRunnerCatalog(db);
    const resolution = resolveSyncRunner({
      launchOverrideRunnerId: args.runnerId ?? null,
      project: {
        syncRunnerId: args.project.syncRunnerId ?? null,
        defaultRunnerId: args.project.defaultRunnerId ?? null,
      },
      platform: { defaultRunnerId: await platformDefaultRunnerId(db) },
      runners,
    });

    runnerTier = resolution.runnerResolutionTier;
    const sessionName = `sync-${claim.attempt}`;
    const snapshot = resolution.runnerSnapshot;

    // Build the resolver prompt BEFORE the CAS (the only remaining DB read is the
    // task load) so a read failure aborts cleanly instead of stranding Running.
    const task = args.taskId ? await loadTask(db, args.taskId) : null;

    prompt = buildResolverPrompt({
      targetRef: targetBranch,
      strategy,
      conflictedFiles,
      task,
    });

    // (3) One locked FOR-UPDATE tx: definitive cap re-check + promotion fence +
    //     Review→Running CAS + run_sessions row + attempt → `agent_running`.
    await db.transaction(async (tx: Db) => {
      await takeSchedulerLock(tx);

      if ((await countLiveRuns(tx, pool)) >= capForPool(pool)) {
        throw new MaisterError(
          "CONFLICT",
          `sync resolver refused — ${pool} pool at capacity`,
        );
      }

      const ws = await loadWorkspaceForUpdate(tx, runId);

      if (ws.promotionState === "claiming" || ws.promotionState === "done") {
        throw new MaisterError(
          "CONFLICT",
          `a promotion is ${ws.promotionState} for run ${runId} — cannot sync`,
        );
      }

      const flip = await markSyncFromReview(runId, { db: tx });

      if (!flip.ok) {
        throw new MaisterError(
          "CONFLICT",
          `run ${runId} left Review concurrently — cannot sync`,
        );
      }

      await tx.insert(runSessions).values({
        id: randomUUID(),
        runId,
        sessionName,
        runnerId: resolution.runnerId,
        runnerResolutionTier: resolution.runnerResolutionTier,
        capabilityAgent: resolution.capabilityAgent,
        runnerSnapshot: snapshot,
        acpSessionId: null,
        resolutionSource: resolution.runnerResolutionTier,
      });

      await tx
        .update(runSyncAttempts)
        .set({
          mode: "agent",
          phase: "agent_running",
          runnerId: resolution.runnerId,
          sessionName,
          agentRunningSince: now(),
          updatedAt: new Date(),
        })
        .where(eq(runSyncAttempts.id, claim.attemptId));
    });

    sessionInput = {
      runId,
      projectSlug: args.project.slug,
      worktreePath: worktree,
      repoPath: repo,
      stepId: SYNC_STEP_ID,
      sessionName,
      executor: runnerExecutorInput(snapshot),
      runner: runnerSupervisorInput({ snapshot }),
    };
  } catch (err) {
    // Pre-session refusal (cap / runner / fence / CAS): abort the conflicted
    // rebase, mark the attempt `aborted`, release the claim. No session spawned.
    await abortSyncOperation(worktree).catch(() => undefined);
    await abortAttempt(db, claim, { conflictedFiles });
    throw err;
  }

  // --- Session: drive the resolver, then verify + push + finalize ---
  let session: { sessionId: string; stopReason: PromptStopReason };

  try {
    session = await runResolverSession({
      db,
      runId,
      input: sessionInput,
      prompt,
      runnerTier,
    });
  } catch (err) {
    // runResolverSession already tore the session down (or none was created).
    await failResolver({
      db,
      claim,
      runId,
      worktree,
      headShaBefore,
      pool,
      errorCode: isMaisterError(err) ? err.code : "CRASH",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const { sessionId, stopReason } = session;

  if (stopReason !== "end_turn") {
    await deleteSession(sessionId).catch(() => undefined);
    await failResolver({
      db,
      claim,
      runId,
      worktree,
      headShaBefore,
      pool,
      errorCode: "CRASH",
      errorMessage: `resolver stopped with ${stopReason}`,
    });
    throw new MaisterError(
      "CRASH",
      `sync resolver did not finish cleanly (stopReason=${stopReason})`,
    );
  }

  // ADR-140: everything from the verify gate through the finalize runs inside a
  // try/catch. The handled failures below terminalize explicitly (and set
  // `settled`), but an UNHANDLED throw here — `forceWithLeasePush` raises
  // EXECUTOR_UNAVAILABLE for every non-lease push failure (network blip, auth
  // expiry, timeout), and any of these awaits can hit a DB blip — used to unwind
  // to the outer catch, which only terminalizes the ATTEMPT. That left the RUN
  // `Running` forever (holding a concurrency slot) with the agent session still
  // live, and the now-terminal attempt locked the recovery sweeps out of it.
  let targetSha: string | null = null;
  let settled = false;
  let pushed = false;
  // Set the instant the force-push LANDS on origin. A landed push is a point of
  // no return: the remote branch (and its PR) already carry the resolved commit,
  // and nothing here can take that back. Past this point a failure may NEVER
  // restore the worktree (it would diverge from what we pushed) nor record the
  // attempt `failed` (the ledger would contradict the remote, and a retry would
  // rebase from state that is no longer what origin has).
  let pushCommitted = false;
  let headShaAfter: string | null = null;

  try {
    // Verify gate (REUSE Task 9).
    await setAttemptPhase(db, claim.attemptId, "verifying");
    targetSha = await localBranchHead({
      projectRepoPath: repo,
      branch: targetBranch,
    });
    const gate = await verifySyncGate(
      worktree,
      targetSha ?? targetBranch,
      branch,
    );

    log.info(
      {
        runId,
        attemptId: claim.attemptId,
        verifyOk: gate.ok,
        reason: gate.ok ? undefined : gate.reason,
      },
      "sync resolver verify gate verdict",
    );

    if (!gate.ok) {
      await deleteSession(sessionId).catch(() => undefined);
      await failResolver({
        db,
        claim,
        runId,
        worktree,
        headShaBefore,
        pool,
        errorCode: "PRECONDITION",
        errorMessage: `verify gate failed: ${gate.reason}`,
      });
      settled = true;
      throw new MaisterError(
        "PRECONDITION",
        `sync verification failed: ${gate.reason}`,
      );
    }

    // Push policy (REUSE Task 9): explicit-SHA force-with-lease iff published.
    headShaAfter = await headCommit({ worktreePath: worktree });
    const shouldPush = args.push ?? args.published;

    pushed = false;

    if (shouldPush) {
      if (args.published && args.remoteShaIndeterminate) {
        await deleteSession(sessionId).catch(() => undefined);
        await failResolver({
          db,
          claim,
          runId,
          worktree,
          headShaBefore,
          pool,
          errorCode: "CONFLICT",
          errorMessage: `could not determine origin/${branch} before fetch — push refused`,
        });
        settled = true;
        throw new MaisterError(
          "CONFLICT",
          `could not determine the remote head of ${branch} — push refused; retry the sync`,
        );
      }

      await setAttemptPhase(db, claim.attemptId, "pushing");
      const push = await pushWithLease(worktree, branch, args.remoteShaBefore);

      if (!push.pushed) {
        await deleteSession(sessionId).catch(() => undefined);
        await failResolver({
          db,
          claim,
          runId,
          worktree,
          headShaBefore,
          pool,
          errorCode: "CONFLICT",
          errorMessage: `force-with-lease rejected — ${branch} moved on origin`,
        });
        settled = true;
        throw new MaisterError(
          "CONFLICT",
          `force-with-lease push rejected — ${branch} moved on origin; retry the sync`,
        );
      }
      pushed = true;
      // The remote now carries the resolved commit — irreversible from here.
      pushCommitted = true;
    }

    // Success finalize: tear the session down, record `succeeded`, restart the
    // auto-promotion grace window (HEAD moved), CAS Running→Review, release the
    // claim, and free the pool slot.
    await deleteSession(sessionId).catch(() => undefined);
    await setAttemptPhase(db, claim.attemptId, "succeeded", {
      headShaAfter,
      pushed,
    });
    await db
      .update(runs)
      .set({ reviewEnteredAt: now() })
      .where(eq(runs.id, runId));
    await markSyncReviewFromRunning(runId, { db });
    await releaseSyncClaim(db, claim);
    await promoteNextPending({ db, pool });

    log.info(
      { runId, attemptId: claim.attemptId, behind, pushed },
      "sync resolver finalized — agent_launched",
    );
  } catch (err) {
    // The session is torn down on every failing path (idempotent).
    await deleteSession(sessionId).catch(() => undefined);

    // `settled` — a handled path above already terminalized this attempt.
    // `pushCommitted` — the force-push LANDED. Aborting now would restore the
    // worktree to the pre-sync commit while origin keeps the resolved one, and
    // would stamp `failed` on a sync that demonstrably happened: the local tree,
    // the remote branch/PR, and the ledger would all disagree, and a retry would
    // rebase from a base origin no longer has. A landed push is never rolled
    // back; the post-push bookkeeping below is best-effort and reconcilable.
    if (!settled && !pushCommitted) {
      await failResolver({
        db,
        claim,
        runId,
        worktree,
        headShaBefore,
        pool,
        errorCode: isMaisterError(err) ? err.code : "CRASH",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    } else if (pushCommitted) {
      log.error(
        {
          runId,
          attemptId: claim.attemptId,
          branch,
          headShaAfter,
          err: err instanceof Error ? err.message : String(err),
        },
        "[FIX:ADR-140] sync push LANDED but finalization failed — worktree and remote agree and were NOT rolled back; releasing the run best-effort, attempt ledger may lag",
      );
      // The push landed and the tree matches it, so the run's work is done: free
      // it and its slot best-effort rather than hold a sync claim that would
      // deadlock promotion AND every future sync on this workspace forever. Each
      // step is independent — a lagging attempt row is a reconcile concern, never
      // a reason to strand the run.
      await markSyncReviewFromRunning(runId, { db }).catch(() => undefined);
      await releaseSyncClaim(db, claim).catch(() => undefined);
      await promoteNextPending({ db, pool }).catch(() => undefined);
    }

    throw err;
  }

  // ADR-140 (Task 13): autoFinalize opt-in — the resolver resolved and the run
  // is back in Review, cleanly rebased on the target. Best-effort chain
  // promoteRun(rebase_merge) → Done. ANY failure degrades to the clean two-step
  // Review state (benign W6 — no new stuck state / promotion crash window). The
  // resolver ran under the SYNC claim, already released above.
  if (args.autoFinalize && args.actor.id && targetSha) {
    try {
      const { promoteRun } = await import("@/lib/runs/promote");

      await promoteRun(
        runId,
        {
          mode: "rebase_merge",
          targetBranch,
          reviewedTargetCommit: targetSha,
        },
        {
          sessionUser: { id: args.actor.id },
          authorize: async () => undefined,
        },
        db,
      );
      log.info(
        { runId, attemptId: claim.attemptId },
        "ai_rebase_merge autoFinalize chained to Done",
      );
    } catch (chainErr) {
      log.warn(
        {
          runId,
          err: chainErr instanceof Error ? chainErr.message : String(chainErr),
        },
        "ai_rebase_merge autoFinalize chain failed — run left in clean Review (two-step)",
      );
    }
  }

  return {
    attemptId: claim.attemptId,
    outcome: "agent_launched",
    behind,
    pushed,
  };
}

// Fail-fast pool-capacity gate under the scheduler lock (decision 15). At cap →
// CONFLICT with no queue; the caller aborts the conflicted rebase.
async function assertPoolCapacity(db: Db, pool: SchedulerPool): Promise<void> {
  const live = await db.transaction(async (tx: Db) => {
    await takeSchedulerLock(tx);

    return countLiveRuns(tx, pool);
  });

  if (live >= capForPool(pool)) {
    throw new MaisterError(
      "CONFLICT",
      `sync resolver refused — ${pool} pool at capacity (${live}/${capForPool(pool)})`,
    );
  }
}
