import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import {
  createAssignment,
  ensureUserActor,
  findActiveAssignmentForRun,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { recordArtifact } from "@/lib/flows/graph/artifact-store";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import { gcAgeDays, promotionClaimTimeoutSeconds } from "@/lib/instance-config";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import {
  deliveryPolicyFromLegacyPromotionMode,
  effectivePromotionModeFromPolicy,
  legacyPromotionModeFromStrategy,
  resolveDeliveryPolicy,
  strategyFromLegacyPromotionMode,
  type DeliveryPolicy,
  type DeliveryPolicyOverride,
  type EffectivePromotionMode,
  type LegacyPromotionMode,
  type StoredDeliveryPolicy,
} from "@/lib/runs/delivery-policy";
import { selectPrAdapter } from "@/lib/runs/pr-adapter";
import { detectProvider, readRemoteOrigin } from "@/lib/repo-source";
import {
  branchExists,
  promoteLocalMerge,
  promoteRebaseMerge,
  pushBranch,
  resolveBaseCommit,
  squashRunBranch,
} from "@/lib/worktree";
import { commitsFromSnapshot } from "@/lib/runs/execution-policy";
import { emitWebhookEvent } from "@/lib/webhooks/outbox";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, scratchRuns, workspaces, projects } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): route + tests pass a minimal drizzle-like fake / a Testcontainers
// pg client; both expose select/update/transaction.
type Db = any;

const log = pino({
  name: "promote-run",
  level: process.env.LOG_LEVEL ?? "info",
});

export type PromoteRunInput = {
  mode?: LegacyPromotionMode;
  deliveryPolicyOverride?: DeliveryPolicyOverride;
  targetBranch?: string;
  reviewedTargetCommit?: string;
  allowTargetDrift?: boolean;
  autoOnReady?: boolean;
};

export type PromoteRunContext = {
  sessionUser: { id: string; name?: string | null; email?: string | null };
  authorize: (projectId: string) => Promise<void>;
  // M37 (ADR-100): WHO is promoting. Absent ⇒ the human session user (existing
  // behavior). An ORCHESTRATOR-driven promote (run_promote / as-plan
  // auto-promote) passes a non-user actor: the promotion is owner-less
  // (promotion_owner_user_id null) and a merge conflict aborts to a typed
  // CONFLICT instead of opening a human merge-conflict assignment — the
  // coordinator / auto-promote leaves the child in Review for a human to resolve.
  actor?:
    | { kind: "user" }
    | { kind: "agent"; agentId: string }
    | { kind: "system" };
};

// M37 (ADR-100): the promotion owner — the session user for a human promote,
// null for an orchestrator-driven (agent/system) promote.
function isHumanPromotion(ctx: PromoteRunContext): boolean {
  return ctx.actor === undefined || ctx.actor.kind === "user";
}

function resolvePromotionOwnerUserId(ctx: PromoteRunContext): string | null {
  return isHumanPromotion(ctx) ? ctx.sessionUser.id : null;
}

export type PromoteRunResult = {
  ok: true;
  mode: LegacyPromotionMode | EffectivePromotionMode;
  deliveryPolicy?: DeliveryPolicy;
  commit?: string;
  pullRequestUrl: string | null;
  prNumber?: number | null;
};

// Workspace states that may be (re)claimed by a fresh promote attempt. A
// `claiming` state is reclaimable only once its claim has gone stale (handled
// separately, see canReclaim).
const RECLAIMABLE_STATES = new Set(["none", "failed"]);

function canReclaim(workspace: {
  promotionState?: string | null;
  promotionClaimedAt?: Date | null;
}): boolean {
  const state = workspace.promotionState ?? "none";

  if (RECLAIMABLE_STATES.has(state)) return true;

  if (state === "claiming") {
    const claimedAt = workspace.promotionClaimedAt
      ? new Date(workspace.promotionClaimedAt)
      : null;

    if (!claimedAt) return true;
    const cutoffMs = Date.now() - promotionClaimTimeoutSeconds() * 1000;

    return claimedAt.getTime() < cutoffMs;
  }

  return false;
}

async function loadRun(db: Db, runId: string): Promise<any> {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));
  const run = rows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }

  return run;
}

async function loadWorkspaceForUpdate(db: Db, runId: string): Promise<any> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.runId, runId))
    .for("update");
  const workspace = rows[0];

  if (!workspace) {
    throw new MaisterError("PRECONDITION", `workspace not found: ${runId}`);
  }
  if (workspace.removedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `workspace already removed for run: ${runId}`,
    );
  }

  return workspace;
}

// M37 (ADR-101): resolve + lock the shared TREE workspace for a writable shared
// child. Only the allocator owns a `workspaces` row (`worktree_path` is UNIQUE,
// keyed by the tree root); a reuser child has none. Find the allocator's row by
// joining `runs` on `(root_run_id, workspace_mode='shared', agent_workspace=
// 'worktree')`, then lock THAT row FOR UPDATE — so every shared child (allocator
// OR reuser) promotes the one tree workspace and concurrent tree-promotes
// serialize on the same row (the exactly-once handle).
async function resolveSharedTreeWorkspaceForUpdate(
  db: Db,
  run: { rootRunId?: string | null },
): Promise<any> {
  if (!run.rootRunId) {
    throw new MaisterError(
      "PRECONDITION",
      "shared-tree promote: run has no root_run_id",
    );
  }

  const found = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(runs, eq(runs.id, workspaces.runId))
    .where(
      and(
        eq(runs.rootRunId, run.rootRunId),
        eq(runs.workspaceMode, "shared"),
        eq(runs.agentWorkspace, "worktree"),
      ),
    );
  const allocatorWorkspaceId = found[0]?.id;

  if (!allocatorWorkspaceId) {
    throw new MaisterError(
      "PRECONDITION",
      `shared-tree workspace not found for root ${run.rootRunId}`,
    );
  }

  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, allocatorWorkspaceId))
    .for("update");
  const workspace = rows[0];

  if (!workspace) {
    throw new MaisterError(
      "PRECONDITION",
      `shared-tree workspace not found for root ${run.rootRunId}`,
    );
  }
  if (workspace.removedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `shared-tree workspace already removed for root ${run.rootRunId}`,
    );
  }

  log.debug(
    {
      rootRunId: run.rootRunId,
      workspaceId: workspace.id,
      worktreePath: workspace.worktreePath,
    },
    "resolved shared tree workspace for promote",
  );

  return workspace;
}

// Route the promote workspace load through the shared-tree resolver for a shared
// writable child; `own` / scratch / PR runs keep the run-id-scoped lookup.
async function loadPromotionWorkspaceForUpdate(db: Db, run: any): Promise<any> {
  if (run.workspaceMode === "shared" && run.agentWorkspace === "worktree") {
    return resolveSharedTreeWorkspaceForUpdate(db, run);
  }

  return loadWorkspaceForUpdate(db, run.id);
}

async function loadProject(db: Db, projectId: string): Promise<any> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));

  return rows[0] ?? null;
}

async function createMergeConflictAssignment(args: {
  db: Db;
  run: any;
  workspace: any;
  sessionUser: PromoteRunContext["sessionUser"];
  targetBranch: string;
}): Promise<void> {
  const existing = await findActiveAssignmentForRun({
    db: args.db,
    runId: args.run.id,
    actionKinds: ["merge_conflict"],
  });

  if (existing !== null) {
    log.info(
      {
        runId: args.run.id,
        projectId: args.run.projectId,
        assignmentId: existing.id,
        targetBranch: args.targetBranch,
      },
      "merge-conflict assignment already active",
    );

    return;
  }

  const actor = await ensureUserActor({
    db: args.db,
    projectId: args.run.projectId,
    userId: args.sessionUser.id,
    label:
      args.sessionUser.name ?? args.sessionUser.email ?? args.sessionUser.id,
  });

  await createAssignment({
    db: args.db,
    projectId: args.run.projectId,
    runId: args.run.id,
    taskId: args.run.taskId ?? null,
    actionKind: "merge_conflict",
    roleRefs: [],
    title: `Resolve merge conflict into ${args.targetBranch}`,
    createdByActorId: actor.id,
    branch: args.workspace.branch,
    ref: args.targetBranch,
  });

  log.info(
    {
      runId: args.run.id,
      projectId: args.run.projectId,
      actorId: actor.id,
      branch: args.workspace.branch,
      targetBranch: args.targetBranch,
    },
    "merge-conflict assignment created",
  );
}

// Best-effort promotion diff artifact (git-range base→run). Never fails the
// finalize: a missing base/head is non-fatal evidence, not a promotion blocker.
async function recordPromotionArtifact(args: {
  db: Db;
  run: any;
  workspace: any;
  baseCommit: string | null;
}): Promise<void> {
  if (!args.baseCommit) return;

  try {
    await recordArtifact(
      {
        runId: args.run.id,
        nodeId: null,
        nodeAttemptId: null,
        artifactDefId: null,
        kind: "diff",
        producer: "runner",
        id: `promote:${args.run.id}:diff`,
        locator: {
          kind: "git-range",
          baseCommit: args.baseCommit,
          headRef: args.workspace.branch,
        },
      },
      args.db,
    );
  } catch (err) {
    log.warn(
      { runId: args.run.id, err: (err as Error).message },
      "promotion diff artifact record failed (non-fatal)",
    );
  }
}

async function promoteMergeSideEffect(args: {
  mode: "local_merge" | "rebase_merge";
  projectRepoPath: string;
  sourceBranch: string;
  targetBranch: string;
}): Promise<string> {
  if (args.mode === "rebase_merge") {
    return promoteRebaseMerge({
      projectRepoPath: args.projectRepoPath,
      sourceBranch: args.sourceBranch,
      targetBranch: args.targetBranch,
    });
  }

  return promoteLocalMerge({
    projectRepoPath: args.projectRepoPath,
    sourceBranch: args.sourceBranch,
    targetBranch: args.targetBranch,
  });
}

function resolvePromotionPolicy(args: {
  input: PromoteRunInput;
  run: any;
  workspace: any;
  project: any | null;
}): DeliveryPolicy {
  const projectMainBranch =
    args.project?.mainBranch ??
    args.input.targetBranch ??
    args.workspace.targetBranch ??
    "main";
  const snapshot = args.run.deliveryPolicySnapshot as DeliveryPolicy | null;
  const legacyPolicy = deliveryPolicyFromLegacyPromotionMode({
    projectPromotionMode:
      args.workspace.promotionMode ?? args.project?.promotionMode ?? null,
    projectMainBranch,
  });
  const projectPolicy =
    (args.project?.deliveryPolicyDefault as StoredDeliveryPolicy | null) ??
    null;
  const basePolicy = snapshot ?? projectPolicy ?? legacyPolicy;
  const modeOverride = args.input.mode
    ? { strategy: strategyFromLegacyPromotionMode(args.input.mode) }
    : {};

  return resolveDeliveryPolicy({
    projectDefault: basePolicy,
    projectPromotionMode: args.workspace.promotionMode,
    projectMainBranch,
    launchOverride: {
      ...modeOverride,
      ...args.input.deliveryPolicyOverride,
      ...(args.input.targetBranch
        ? { targetBranch: args.input.targetBranch }
        : {}),
    },
  });
}

function promotionModeForEffectiveMode(
  mode: EffectivePromotionMode,
): LegacyPromotionMode {
  if (mode === "ai_rebase_merge") return "rebase_merge";

  return legacyPromotionModeFromStrategy(mode);
}

async function maybePushTargetBranch(args: {
  db: Db;
  claim: FlowClaim;
  commit: string;
}): Promise<void> {
  if (args.claim.policy.push !== "on_success") return;

  try {
    await pushBranch({
      projectRepoPath: args.claim.workspace.parentRepoPath,
      remote: "origin",
      branch: args.claim.resolvedTarget,
    });
    log.info(
      {
        runId: args.claim.run.id,
        projectId: args.claim.run.projectId,
        mode: args.claim.resolvedMode,
        targetBranch: args.claim.resolvedTarget,
        commit: args.commit,
      },
      "flow run target branch pushed after promotion",
    );
  } catch (err) {
    await markPromotionFailed(
      args.db,
      args.claim.workspace.id,
      args.claim.attemptId,
    );
    log.warn(
      {
        runId: args.claim.run.id,
        projectId: args.claim.run.projectId,
        mode: args.claim.resolvedMode,
        targetBranch: args.claim.resolvedTarget,
        command: `git push origin ${args.claim.resolvedTarget}`,
        parentRepoPath: args.claim.workspace.parentRepoPath,
        err: (err as Error).message,
      },
      "flow run promotion degraded to manual after push failure",
    );
    throw err;
  }
}

// Whether the run's commit policy collapses base..HEAD pre-promotion (C2). This
// is the RETRY-STABLE force-push signal for PR mode: it derives from the
// IMMUTABLE execution-policy snapshot, NOT from a per-attempt squash result. A
// transient push failure leaves the local branch already rewritten and the claim
// retryable; on the reclaim the squash is a no-op (≤1 commit), so a result-based
// force decision would drop to a non-forced push and hit a non-fast-forward
// against the un-updated remote. The policy predicate keeps the reclaim forcing.
function squashesRunHistory(claim: FlowClaim): boolean {
  if (claim.run.runKind !== "flow" || !claim.baseCommit) return false;
  const commitPolicy = commitsFromSnapshot(claim.run.executionPolicy);

  return (
    commitPolicy === "squash_rework" || commitPolicy === "squash_on_promote"
  );
}

// C2 (execution-policy commits): collapse the run branch's history (base..HEAD)
// into one commit pre-promotion for flow runs whose policy is squash_rework /
// squash_on_promote. Tree-preserving inside squashRunBranch; any drift/failure
// silently keeps the original history (keep_all). Applies to BOTH merge and PR
// promotions. Idempotent: a no-op (≤1 commit) on a reclaim after a prior attempt
// already squashed. Skipped for keep_all/defer + legacy rows lacking a base
// commit. The PR force-push decision is the policy predicate (squashesRunHistory),
// NOT this op's result, so it survives a transient-push retry.
async function squashForCommitPolicy(
  claim: FlowClaim,
  runId: string,
): Promise<void> {
  if (!squashesRunHistory(claim)) return;
  const commitPolicy = commitsFromSnapshot(claim.run.executionPolicy);

  try {
    const squash = await squashRunBranch({
      worktreePath: claim.workspace.worktreePath,
      baseCommit: claim.baseCommit as string,
      message: `maister: run ${runId} (history squashed for promote)`,
    });

    log.info(
      {
        runId,
        commitPolicy,
        squashed: squash.squashed,
        collapsed: squash.collapsed,
        reason: squash.reason,
      },
      "[squash] commit-policy applied pre-promote",
    );
  } catch (err) {
    // Squash is best-effort; never let it fail the promote (keep_all).
    log.error(
      { runId, commitPolicy, err: (err as Error).message },
      "[squash] threw — promoting original history (keep_all)",
    );
  }
}

// ---- workspace-backed flow/agent promotion -------------------------------

async function promoteWorkspaceRun(
  runId: string,
  input: PromoteRunInput,
  ctx: PromoteRunContext,
  db: Db,
): Promise<PromoteRunResult> {
  // ---- Claim tx: short, commits BEFORE any side-effect (§3.2 step 1). The
  // SELECT … FOR UPDATE row lock serializes concurrent claims: the second waits
  // for the first to commit, then sees a fresh `claiming` and is refused.
  const claim = await db.transaction(async (tx: Db) => {
    // M37 (ADR-101): load the run FIRST so a shared writable child resolves + locks
    // the shared TREE workspace by `(root_run_id, workspace_mode='shared')`, not its
    // own (absent) row. `own` / scratch keep the run-id lookup.
    const run = await loadRun(tx, runId);
    const workspace = await loadPromotionWorkspaceForUpdate(tx, run);

    if (run.status !== "Review") {
      throw new MaisterError(
        "PRECONDITION",
        `${run.runKind} run must be Review before promotion: ${run.status}`,
      );
    }

    await ctx.authorize(run.projectId);

    // Legacy-row fallback (§3.6): derive a missing target branch from the
    // project's main branch, never a silent null into git. Policy-era rows use
    // the run snapshot; pre-policy rows keep the old workspace/request mode.
    let project: any = null;
    const needsProjectFallback =
      (!run.deliveryPolicySnapshot && !workspace.promotionMode) ||
      (!input.targetBranch && !workspace.targetBranch);

    if (needsProjectFallback) {
      project = await loadProject(tx, run.projectId);
    }

    const policy = resolvePromotionPolicy({ input, run, workspace, project });
    const resolvedTarget = policy.targetBranch ?? null;

    if (!resolvedTarget) {
      throw new MaisterError(
        "PRECONDITION",
        "legacy run lacks branch metadata — relaunch to promote",
      );
    }

    const resolvedMode = effectivePromotionModeFromPolicy(policy);
    const promotionMode = promotionModeForEffectiveMode(resolvedMode);

    if (run.runKind === "flow") {
      // Readiness re-gate (T2.3) — NO claim, NO git on a not-ready verdict.
      const readiness = await assertEvidenceReady(runId, "review", tx);

      log.debug(
        {
          runId,
          ready: readiness.ready,
          reasons: readiness.reasons,
        },
        "promote readiness verdict",
      );

      if (!readiness.ready) {
        throw new MaisterError(
          "PRECONDITION",
          `promotion blocked — evidence not ready: ${readiness.reasons.join("; ")}`,
        );
      }
    }

    // Target-drift gate (Codex F6, §3.7). reviewedTargetCommit is required on
    // EVERY flow promotion (never promote blind), and the target is ALWAYS
    // resolved — proving it exists before a claim or any side-effect.
    // allowTargetDrift waives ONLY the SHA-equality comparison; it never skips
    // the reviewed-SHA input or the target-existence check.
    if (!input.autoOnReady && !input.reviewedTargetCommit) {
      throw new MaisterError(
        "PRECONDITION",
        "reviewedTargetCommit is required",
      );
    }

    const liveTip = await resolveBaseCommit({
      projectRepoPath: workspace.parentRepoPath,
      baseRef: resolvedTarget,
    });

    if (
      !input.autoOnReady &&
      !input.allowTargetDrift &&
      liveTip !== input.reviewedTargetCommit
    ) {
      log.debug(
        {
          runId,
          resolvedTarget,
          liveTip,
          reviewedTargetCommit: input.reviewedTargetCommit,
        },
        "promote target-drift refusal",
      );
      throw new MaisterError(
        "PRECONDITION",
        "target advanced since review — re-review or override",
      );
    }

    if (!canReclaim(workspace)) {
      throw new MaisterError(
        "CONFLICT",
        "promotion already in progress for this run",
      );
    }

    const attemptId = randomUUID();
    const claimedAt = new Date();

    await tx
      .update(workspaces)
      .set({
        promotionState: "claiming",
        promotionAttemptId: attemptId,
        promotionClaimedAt: claimedAt,
        promotionOwnerUserId: resolvePromotionOwnerUserId(ctx),
        promotionMode,
        targetBranch: resolvedTarget,
      })
      .where(eq(workspaces.id, workspace.id));

    log.debug(
      { runId, attemptId, resolvedMode, resolvedTarget, policy },
      "promote claim minted",
    );

    return {
      attemptId,
      run,
      workspace,
      resolvedMode,
      responseMode: input.mode ?? resolvedMode,
      promotionMode,
      resolvedTarget,
      policy,
      baseCommit: workspace.baseCommit ?? null,
    };
  });

  if (claim.resolvedMode === "ai_rebase_merge") {
    log.info(
      {
        runId,
        projectId: claim.run.projectId,
        attemptId: claim.attemptId,
        targetBranch: claim.resolvedTarget,
      },
      "ai_rebase_merge promotion attempt started",
    );
  }

  // C2 (execution-policy commits): collapse the run branch's history (base..HEAD)
  // into one commit pre-promotion for squash_rework / squash_on_promote, BEFORE
  // either side-effect so it applies to merge AND PR promotions. Tree-preserving
  // + best-effort inside the helper (any drift/failure keeps the full history).
  await squashForCommitPolicy(claim, runId);

  // ---- Side-effects: NO lock held (§3.2 step 2).
  if (claim.resolvedMode === "pull_request") {
    return promotePullRequestSideEffect({
      runId,
      ctx,
      db,
      claim,
      // Force-push (--force-with-lease) when the commit policy squashes. Derived
      // from the immutable policy, NOT this attempt's squash result, so a reclaim
      // after a transient push failure still force-updates the already-rewritten
      // branch onto a remote that may hold the old history (no non-fast-forward).
      forcePush: squashesRunHistory(claim),
    });
  }

  let commit: string;

  try {
    const mergeMode =
      claim.promotionMode === "rebase_merge" ? "rebase_merge" : "local_merge";

    commit = await promoteMergeSideEffect({
      mode: mergeMode,
      projectRepoPath: claim.workspace.parentRepoPath,
      sourceBranch: claim.workspace.branch,
      targetBranch: claim.resolvedTarget,
    });
    await maybePushTargetBranch({ db, claim, commit });
  } catch (err) {
    if (isMaisterError(err) && err.code === "CONFLICT") {
      if (claim.resolvedMode === "ai_rebase_merge") {
        log.warn(
          {
            runId,
            projectId: claim.run.projectId,
            attemptId: claim.attemptId,
            targetBranch: claim.resolvedTarget,
            sourceBranch: claim.workspace.branch,
            parentRepoPath: claim.workspace.parentRepoPath,
            command: `git rebase ${claim.resolvedTarget}`,
          },
          "ai_rebase_merge promotion conflict surfaced to assignment",
        );
      }

      await db.transaction(async (tx: Db) => {
        const ws = await loadPromotionWorkspaceForUpdate(tx, claim.run);

        // Only the owning attempt records the failure (token-matched).
        if (ws.promotionAttemptId !== claim.attemptId) return;

        // M37 (ADR-100): a HUMAN promote opens a merge-conflict assignment for a
        // reviewer to resolve; an ORCHESTRATOR-driven promote does NOT — it
        // aborts to CONFLICT (rethrown below), leaving the child in Review for a
        // human to resolve (no auto-resolve, §8).
        if (isHumanPromotion(ctx)) {
          await createMergeConflictAssignment({
            db: tx,
            run: claim.run,
            workspace: claim.workspace,
            sessionUser: ctx.sessionUser,
            targetBranch: claim.resolvedTarget,
          });
        }
        await tx
          .update(workspaces)
          .set({ promotionState: "failed" })
          .where(
            and(
              eq(workspaces.id, claim.workspace.id),
              eq(workspaces.promotionAttemptId, claim.attemptId),
            ),
          );
      });
    }

    throw err;
  }

  // ---- Finalize tx: assert the attempt token still matches (§3.2 step 3).
  const result = await db.transaction(async (tx: Db) => {
    const ws = await loadPromotionWorkspaceForUpdate(tx, claim.run);

    if (
      ws.promotionState !== "claiming" ||
      ws.promotionAttemptId !== claim.attemptId
    ) {
      // A same-user stale reclaim re-minted the token while our side-effect ran:
      // this attempt is superseded. Write NOTHING; the reclaiming attempt owns
      // finalization.
      log.warn(
        {
          runId,
          minted: claim.attemptId,
          observed: ws.promotionAttemptId,
          state: ws.promotionState,
        },
        "promote finalize superseded by a newer attempt",
      );
      throw new MaisterError(
        "CONFLICT",
        "promotion superseded by a newer attempt",
      );
    }

    const now = new Date();
    const scheduledRemovalAt = new Date(
      now.getTime() + gcAgeDays() * 86_400_000,
    );

    // Every finalize write is token-scoped (§3.2): defense-in-depth so the Done
    // flip fails closed even if the lock/assert above is ever removed.
    await tx
      .update(runs)
      .set({
        status: "Done",
        acpSessionId: null,
        currentStepId: null,
        endedAt: now,
      })
      .where(eq(runs.id, runId));
    await tx
      .update(workspaces)
      .set({
        promotionState: "done",
        promotedAt: now,
        scheduledRemovalAt,
      })
      .where(
        and(
          eq(workspaces.id, claim.workspace.id),
          eq(workspaces.promotionAttemptId, claim.attemptId),
        ),
      );
    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId,
      reason: "run promoted to Done",
    });

    await emitWebhookEvent({
      db: tx,
      type: "run.promoted",
      projectId: claim.run.projectId,
      runId,
      data: {
        mode: claim.responseMode,
        target: claim.resolvedTarget,
        deliveryPolicy: claim.policy,
        pullRequestUrl: null,
      },
    });
    await emitWebhookEvent({
      db: tx,
      type: "run.done",
      projectId: claim.run.projectId,
      runId,
      data: {},
    });
    await emitDomainEvent({
      db: tx,
      kind: "run.done",
      projectId: claim.run.projectId,
      runId,
      taskId: claim.run.taskId ?? null,
      actor: { type: "system", id: null },
      parentRunId: claim.run.parentRunId,
      payload: {
        runId,
        taskId: claim.run.taskId ?? null,
        flowId: claim.run.flowId ?? null,
        runKind: claim.run.runKind,
      },
    });

    log.info(
      {
        runId,
        mode: claim.responseMode,
        commit,
        targetBranch: claim.resolvedTarget,
        deliveryPolicy: claim.policy,
      },
      "workspace run promoted to Done",
    );

    return {
      ok: true as const,
      mode: claim.responseMode,
      deliveryPolicy: claim.policy,
      commit,
      pullRequestUrl: null,
      prNumber: null,
    };
  });

  // ---- Artifact AFTER the finalize commit (fix #1). The promotion diff is
  // observability — fully reconstructable from git — so a failed artifact INSERT
  // must NEVER poison the finalize tx and silently roll back the durable Done
  // flip / promotion_state='done' / assignment close. Best-effort, own
  // connection, only logs on failure.
  await recordPromotionArtifact({
    db,
    run: claim.run,
    workspace: claim.workspace,
    baseCommit: claim.baseCommit,
  });

  return result;
}

type FlowClaim = {
  attemptId: string;
  run: any;
  workspace: any;
  resolvedMode: EffectivePromotionMode;
  responseMode: LegacyPromotionMode | EffectivePromotionMode;
  promotionMode: LegacyPromotionMode;
  resolvedTarget: string;
  policy: DeliveryPolicy;
  baseCommit: string | null;
};

// PR-mode side-effect (§3.2 step 4/5): preflight → push → createOrUpdatePr →
// finalize. Classification mirrors the table in §3.2:
//   - preflight / unsupported-provider → PRECONDITION: terminal-config, the
//     claim is CAS'd to `failed` (token-scoped, reclaimable), run stays Review.
//   - push rejected / PR-API 5xx → EXECUTOR_UNAVAILABLE: transient, the claim is
//     LEFT `claiming` (a same-attempt retry / stale reclaim resumes), no pr_url.
async function promotePullRequestSideEffect(args: {
  runId: string;
  ctx: PromoteRunContext;
  db: Db;
  claim: FlowClaim;
  // C2: the run branch was squash-rewritten pre-push, so an existing PR branch
  // must be force-updated (--force-with-lease). False when no squash ran.
  forcePush?: boolean;
}): Promise<PromoteRunResult> {
  const { runId, ctx, db, claim } = args;
  const project = await loadProject(db, claim.run.projectId);
  const remoteUrl =
    project?.repoUrl ??
    (await readRemoteOrigin(claim.workspace.parentRepoPath));
  const provider =
    project?.provider ?? (remoteUrl ? detectProvider(remoteUrl) : "generic");

  // Preflight / dispatch failures are terminal-config (PRECONDITION): mark the
  // claim failed (token-scoped) so a later attempt can reclaim, then rethrow.
  try {
    const adapter = selectPrAdapter(provider, { remoteUrl });

    await adapter.preflight();

    // Push then open/update the PR — both are transient on failure (the helpers
    // throw EXECUTOR_UNAVAILABLE), so the claim is intentionally LEFT claiming.
    await pushBranch({
      projectRepoPath: claim.workspace.parentRepoPath,
      remote: "origin",
      branch: claim.workspace.branch,
      // Only force when a squash rewrote base..HEAD — keeps a plain (keep_all)
      // PR push a non-forced fast-forward.
      ...(args.forcePush ? { force: true } : {}),
    });

    const pr = await adapter.createOrUpdatePr({
      repoPath: claim.workspace.parentRepoPath,
      remote: "origin",
      sourceBranch: claim.workspace.branch,
      targetBranch: claim.resolvedTarget,
      title: prTitle(claim),
      body: prBody(claim),
    });

    return finalizePullRequest({ runId, ctx, db, claim, pr });
  } catch (err) {
    if (isMaisterError(err) && err.code === "EXECUTOR_UNAVAILABLE") {
      // Transient: leave the claim `claiming`; do NOT mark failed, do NOT write
      // pr_url. A same-attempt retry resumes; a stale claim is reclaimed later.
      throw err;
    }

    // Terminal-config (PRECONDITION / unsupported provider): release the claim.
    await markPromotionFailed(db, claim.workspace.id, claim.attemptId);
    throw err;
  }
}

function prTitle(claim: FlowClaim): string {
  return `MAIster: promote ${claim.workspace.branch} → ${claim.resolvedTarget}`;
}

function prBody(claim: FlowClaim): string {
  return `Promotes \`${claim.workspace.branch}\` into \`${claim.resolvedTarget}\` (run ${claim.run.id}).`;
}

async function finalizePullRequest(args: {
  runId: string;
  ctx: PromoteRunContext;
  db: Db;
  claim: FlowClaim;
  pr: { url: string; number: number };
}): Promise<PromoteRunResult> {
  const { runId, db, claim, pr } = args;

  const result = await db.transaction(async (tx: Db) => {
    const ws = await loadWorkspaceForUpdate(tx, runId);

    if (
      ws.promotionState !== "claiming" ||
      ws.promotionAttemptId !== claim.attemptId
    ) {
      log.warn(
        {
          runId,
          minted: claim.attemptId,
          observed: ws.promotionAttemptId,
          state: ws.promotionState,
        },
        "promote PR finalize superseded by a newer attempt",
      );
      throw new MaisterError(
        "CONFLICT",
        "promotion superseded by a newer attempt",
      );
    }

    const now = new Date();
    const scheduledRemovalAt = new Date(
      now.getTime() + gcAgeDays() * 86_400_000,
    );

    await tx
      .update(runs)
      .set({
        status: "Done",
        acpSessionId: null,
        currentStepId: null,
        endedAt: now,
      })
      .where(eq(runs.id, runId));
    await tx
      .update(workspaces)
      .set({
        promotionState: "done",
        promotedAt: now,
        scheduledRemovalAt,
        prUrl: pr.url,
        prNumber: pr.number,
      })
      .where(
        and(
          eq(workspaces.id, claim.workspace.id),
          eq(workspaces.promotionAttemptId, claim.attemptId),
        ),
      );
    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId,
      reason: "run promoted to Done",
    });

    await emitWebhookEvent({
      db: tx,
      type: "run.promoted",
      projectId: claim.run.projectId,
      runId,
      data: {
        mode: claim.responseMode,
        target: claim.resolvedTarget,
        deliveryPolicy: claim.policy,
        pullRequestUrl: pr.url,
      },
    });
    await emitWebhookEvent({
      db: tx,
      type: "run.done",
      projectId: claim.run.projectId,
      runId,
      data: {},
    });
    await emitDomainEvent({
      db: tx,
      kind: "run.done",
      projectId: claim.run.projectId,
      runId,
      taskId: claim.run.taskId ?? null,
      actor: { type: "system", id: null },
      parentRunId: claim.run.parentRunId,
      payload: {
        runId,
        taskId: claim.run.taskId ?? null,
        flowId: claim.run.flowId ?? null,
        runKind: claim.run.runKind,
      },
    });

    log.info(
      {
        runId,
        mode: claim.responseMode,
        prUrl: pr.url,
        prNumber: pr.number,
        targetBranch: claim.resolvedTarget,
      },
      "workspace run promoted to Done via pull request",
    );

    return {
      ok: true as const,
      mode: claim.responseMode,
      deliveryPolicy: claim.policy,
      pullRequestUrl: pr.url,
      prNumber: pr.number,
    };
  });

  // PR artifact AFTER the finalize commit — same decoupling as the diff artifact.
  await recordPrArtifact({
    db,
    run: claim.run,
    workspace: claim.workspace,
    pr,
  });

  return result;
}

// Best-effort PR-evidence artifact carrying pr_url/pr_number in its payload (no
// new artifact kind — Q3). Never fails the finalize.
async function recordPrArtifact(args: {
  db: Db;
  run: any;
  workspace: any;
  pr: { url: string; number: number };
}): Promise<void> {
  try {
    await recordArtifact(
      {
        runId: args.run.id,
        nodeId: null,
        nodeAttemptId: null,
        artifactDefId: null,
        kind: "commit_set",
        producer: "runner",
        id: `promote:${args.run.id}:pr`,
        locator: {
          kind: "inline",
          text: JSON.stringify({
            pr_url: args.pr.url,
            pr_number: args.pr.number,
            branch: args.workspace.branch,
          }),
        },
        uri: args.pr.url,
      },
      args.db,
    );
  } catch (err) {
    log.warn(
      { runId: args.run.id, err: (err as Error).message },
      "promotion PR artifact record failed (non-fatal)",
    );
  }
}

async function markPromotionFailed(
  db: Db,
  workspaceId: string,
  attemptId: string,
): Promise<void> {
  await db.transaction(async (tx: Db) => {
    const rows = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update");
    const ws = rows[0];

    if (!ws || ws.promotionAttemptId !== attemptId) return;
    await tx
      .update(workspaces)
      .set({ promotionState: "failed" })
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.promotionAttemptId, attemptId),
        ),
      );
  });
}

// ---- scratch promotion (behavior preserved) -------------------------------

async function promoteScratchRun(
  runId: string,
  input: PromoteRunInput,
  ctx: PromoteRunContext,
  db: Db,
): Promise<PromoteRunResult> {
  // Scratch runs are ephemeral and target-locked to their base branch; PR mode
  // is a flow-run promotion only (§3.2). Refuse before minting a claim.
  if (input.mode !== "local_merge") {
    throw new MaisterError(
      "PRECONDITION",
      `${input.mode} promotion is not supported for scratch runs`,
    );
  }

  const claim = await db.transaction(async (tx: Db) => {
    const workspace = await loadWorkspaceForUpdate(tx, runId);
    const run = await loadRun(tx, runId);

    const scratchRows = await tx
      .select()
      .from(scratchRuns)
      .where(eq(scratchRuns.runId, runId));
    const scratch = scratchRows[0];

    if (!scratch) {
      throw new MaisterError(
        "PRECONDITION",
        `scratch metadata not found: ${runId}`,
      );
    }
    if (scratch.dialogStatus !== "Review") {
      throw new MaisterError(
        "PRECONDITION",
        `scratch run must be Review before promotion: ${scratch.dialogStatus}`,
      );
    }

    await ctx.authorize(run.projectId);

    // Target locked to the scratch base branch (no flow relaxation, no drift).
    const targetBranch = input.targetBranch ?? scratch.baseBranch;

    if (targetBranch !== scratch.baseBranch) {
      throw new MaisterError(
        "PRECONDITION",
        `promotion target branch is outside project policy: ${targetBranch}`,
      );
    }

    // M15 merge-readiness guard on scratch promote (preserved across the M18
    // refactor-to-service): refuse a not-ready scratch run BEFORE minting the
    // claim — no claim, no git on a not-ready verdict.
    const readiness = await assertEvidenceReady(runId, "merge", tx);

    if (!readiness.ready) {
      throw new MaisterError(
        "PRECONDITION",
        `merge refused: evidence not ready — ${readiness.reasons.join("; ")}`,
      );
    }

    if (!canReclaim(workspace)) {
      throw new MaisterError(
        "CONFLICT",
        "promotion already in progress for this run",
      );
    }

    const attemptId = randomUUID();

    await tx
      .update(workspaces)
      .set({
        promotionState: "claiming",
        promotionAttemptId: attemptId,
        promotionClaimedAt: new Date(),
        promotionOwnerUserId: ctx.sessionUser.id,
        promotionMode: "local_merge",
        targetBranch,
      })
      .where(eq(workspaces.id, workspace.id));

    return { attemptId, run, workspace, scratch, targetBranch };
  });

  const targetExists = await branchExists({
    projectRepoPath: claim.workspace.parentRepoPath,
    branch: claim.targetBranch,
  });

  if (!targetExists) {
    await markPromotionFailed(db, claim.workspace.id, claim.attemptId);
    throw new MaisterError(
      "PRECONDITION",
      `promotion target branch does not exist: ${claim.targetBranch}`,
    );
  }

  let commit: string;

  try {
    commit = await promoteLocalMerge({
      projectRepoPath: claim.workspace.parentRepoPath,
      sourceBranch: claim.workspace.branch,
      targetBranch: claim.targetBranch,
    });
  } catch (err) {
    if (isMaisterError(err) && err.code === "CONFLICT") {
      await db.transaction(async (tx: Db) => {
        const rows = await tx
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, claim.workspace.id))
          .for("update");
        const ws = rows[0];

        if (!ws || ws.promotionAttemptId !== claim.attemptId) return;
        await createMergeConflictAssignment({
          db: tx,
          run: claim.run,
          workspace: claim.workspace,
          sessionUser: ctx.sessionUser,
          targetBranch: claim.targetBranch,
        });
        await tx
          .update(workspaces)
          .set({ promotionState: "failed" })
          .where(
            and(
              eq(workspaces.id, claim.workspace.id),
              eq(workspaces.promotionAttemptId, claim.attemptId),
            ),
          );
      });
    }

    throw err;
  }

  return db.transaction(async (tx: Db) => {
    const ws = await loadWorkspaceForUpdate(tx, runId);

    if (
      ws.promotionState !== "claiming" ||
      ws.promotionAttemptId !== claim.attemptId
    ) {
      throw new MaisterError(
        "CONFLICT",
        "promotion superseded by a newer attempt",
      );
    }

    const now = new Date();
    const scheduledRemovalAt = new Date(
      now.getTime() + gcAgeDays() * 86_400_000,
    );

    await tx
      .update(scratchRuns)
      .set({
        dialogStatus: "Done",
        targetBranch: claim.targetBranch,
        supervisorSessionId: null,
        updatedAt: now,
      })
      .where(eq(scratchRuns.runId, runId));
    await tx
      .update(runs)
      .set({
        status: "Done",
        acpSessionId: null,
        currentStepId: null,
        endedAt: now,
      })
      .where(eq(runs.id, runId));
    await tx
      .update(workspaces)
      .set({
        promotionState: "done",
        promotedAt: now,
        scheduledRemovalAt,
      })
      .where(
        and(
          eq(workspaces.id, claim.workspace.id),
          eq(workspaces.promotionAttemptId, claim.attemptId),
        ),
      );
    await systemCloseActiveAssignmentsForRun({
      db: tx,
      runId,
      reason: "run promoted to Done",
    });

    await emitWebhookEvent({
      db: tx,
      type: "run.promoted",
      projectId: claim.run.projectId,
      runId,
      data: {
        mode: "local_merge",
        target: claim.targetBranch,
        pullRequestUrl: null,
      },
    });
    await emitWebhookEvent({
      db: tx,
      type: "run.done",
      projectId: claim.run.projectId,
      runId,
      data: {},
    });
    await emitDomainEvent({
      db: tx,
      kind: "run.done",
      projectId: claim.run.projectId,
      runId,
      taskId: claim.run.taskId ?? null,
      actor: { type: "system", id: null },
      parentRunId: claim.run.parentRunId,
      payload: {
        runId,
        taskId: claim.run.taskId ?? null,
        flowId: claim.run.flowId ?? null,
        runKind: claim.run.runKind,
      },
    });

    return {
      ok: true as const,
      mode: "local_merge" as const,
      commit,
      pullRequestUrl: null,
      prNumber: null,
    };
  });
}

/**
 * Shared promotion service over run kinds. Flow runs get the readiness re-gate
 * + target-drift gate + relaxed target; agent worktree runs use the same
 * workspace promotion path without flow evidence gates; scratch runs stay
 * target-locked with the M15 merge-readiness guard. All paths run through the
 * durable promotion claim (§3.2, Codex F1/F5): claim CAS committed before the
 * side-effect, finalize keyed on the per-attempt `promotion_attempt_id` token.
 */
export async function promoteRun(
  runId: string,
  input: PromoteRunInput,
  ctx: PromoteRunContext,
  db?: Db,
): Promise<PromoteRunResult> {
  const d = (db ?? getDb()) as Db;
  const run = await loadRun(d, runId);

  if (run.runKind === "scratch") {
    return promoteScratchRun(runId, input, ctx, d);
  }

  return promoteWorkspaceRun(runId, input, ctx, d);
}

// M37 (ADR-100): orchestrator-driven promotion of a reviewed child. Used by the
// run_promote ext route (agent actor) and the as-plan auto-promoter (system
// actor). The CALLER must already have scoped the child — a direct child of the
// bound orchestrator (run_promote) or an as-plan auto child (auto-launch) — to
// the token's project. Reuses promoteRun's merge core with a NON-user actor:
// owner-less, and a merge conflict aborts to CONFLICT (no human assignment),
// leaving the child in Review. Forces `local_merge` (the autonomous mode — a
// pull_request would not flip the child to Done). The child → Done finalize emits
// run.done with parent_run_id, which wakes the orchestrator AND advances the
// as-plan task + releases its `requires` dependents.
export async function promoteChildRunForToken(
  childRunId: string,
  opts: {
    projectId: string;
    actor: { kind: "agent"; agentId: string } | { kind: "system" };
    db?: Db;
  },
): Promise<PromoteRunResult> {
  return promoteRun(
    childRunId,
    // M37 (ADR-100) fix: an orchestrator/system promote is AUTONOMOUS — there is
    // no human-reviewed SHA, so it must set `autoOnReady` exactly like the
    // delivery-policy auto-promoter (auto-delivery.ts). Without it the
    // target-drift gate throws PRECONDITION "reviewedTargetCommit is required",
    // dead-ending BOTH run_promote AND the as-plan auto-promoter. `autoOnReady`
    // waives ONLY the reviewed-SHA/drift check; the readiness re-gate
    // (assertEvidenceReady) still runs, so a not-ready child still cannot promote.
    { mode: "local_merge", autoOnReady: true },
    {
      // sessionUser is never dereferenced for a non-user actor (owner → null and
      // the conflict-assignment is skipped); a placeholder satisfies the shared
      // context type without inventing a user row.
      sessionUser: { id: `orchestrator:${opts.projectId}` },
      // The caller already scoped the child to the token's project + parent.
      authorize: async () => {},
      actor: opts.actor,
    },
    opts.db,
  );
}
