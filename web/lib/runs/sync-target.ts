import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, notInArray, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { isExperimentMemberRun } from "@/lib/experiments/membership";
import {
  aheadBehindCounts,
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
  statusPorcelain,
  syncOperationInProgress,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants — mirror promote.ts's bridge.
const { runs, workspaces, projects, runSyncAttempts } =
  schemaModule as unknown as Record<string, any>;

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
  // The AI-resolver seam (Task 10). Undefined defaults to the plan's agent-on
  // behavior, but until Task 10 lands a conflict with `agent` truthy behaves like
  // `agent:false` (clean abort, `outcome:"conflict"`) so no stuck state exists.
  agent?: boolean;
  push?: boolean;
  runnerId?: string;
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
};

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
export async function verifySyncGate(
  worktree: string,
  targetSha: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (await syncOperationInProgress(worktree)) {
    return { ok: false, reason: "a rebase or merge is still in progress" };
  }
  if ((await statusPorcelain({ worktreePath: worktree })).trim() !== "") {
    return { ok: false, reason: "the worktree is not clean" };
  }
  if (await hasConflictMarkers(worktree)) {
    return { ok: false, reason: "leftover conflict markers remain" };
  }
  // aheadBehindCounts(base=target, ref=HEAD).behind === 0 ⇔ target ⊆ HEAD ⇔ the
  // target is an ancestor of the synced HEAD.
  const { behind } = await aheadBehindCounts(worktree, targetSha, "HEAD");

  if (behind !== 0) {
    return {
      ok: false,
      reason: "the target is not an ancestor of the synced HEAD",
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

// Free the shared lifecycle slot this attempt holds. Guarded on
// `lifecycle_operation_name='sync'` so it is idempotent (a second call after the
// slot is already freed matches no row) and never releases another op's claim.
async function releaseSyncClaim(db: Db, workspaceId: string): Promise<void> {
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
  await releaseSyncClaim(db, claim.workspaceId);
}

// Terminal write for an aborted attempt (divergence / clean conflict abort):
// record `aborted`, then release the claim. No run mutation — status stays Review.
async function abortAttempt(
  db: Db,
  claim: Claim,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await setAttemptPhase(db, claim.attemptId, "aborted", extra);
  await releaseSyncClaim(db, claim.workspaceId);
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
  await releaseSyncClaim(db, claim.workspaceId);
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
  await releaseSyncClaim(db, claim.workspaceId);
}

/**
 * The MECHANICAL branch-sync service (ADR-138, Task 9) — and the reusable shared
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
      actorType: input.actor.type,
      actorId: input.actor.id,
    });

    // (e) take the shared workspace lifecycle slot as `sync`.
    await tx
      .update(workspaces)
      .set({
        lifecycleOperationState: "claiming",
        lifecycleOperationClaimedAt: now(),
        lifecycleOperationAttemptId: randomUUID(),
        lifecycleOperationName: "sync",
      })
      .where(eq(workspaces.id, ws.id));

    log.debug({ runId, attemptId, attempt, strategy }, "sync claim minted");

    return { attemptId, attempt, workspaceId: ws.id };
  });

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

    // 8. Conflict — abort cleanly (rebase/merge --abort restores the pre-sync
    //    HEAD) and return `conflict`. The `agent` branch is the Task 10 seam.
    if (!applied.ok) {
      // TODO(Task 10): when `input.agent` is truthy, launch the AI resolver here
      // (markSyncFromReview + resolver driver) → phase 'agent_running' →
      // outcome "agent_launched"; do NOT abort. Until then it behaves like
      // agent=false so no stuck state exists between commits.
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
        "sync conflict — aborted (agent seam behaves as agent=false in Task 9)",
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
    const gate = await verifySyncGate(worktree, targetSha ?? targetBranch);

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
  }
}
