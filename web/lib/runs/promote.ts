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
import {
  branchExists,
  promoteLocalMerge,
  resolveBaseCommit,
} from "@/lib/worktree";

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
  mode: "local_merge" | "pull_request";
  targetBranch?: string;
  reviewedTargetCommit?: string;
  allowTargetDrift?: boolean;
};

export type PromoteRunContext = {
  sessionUser: { id: string; name?: string | null; email?: string | null };
  authorize: (projectId: string) => Promise<void>;
};

export type PromoteRunResult = {
  ok: true;
  mode: "local_merge" | "pull_request";
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

// ---- flow promotion -------------------------------------------------------

async function promoteFlowRun(
  runId: string,
  input: PromoteRunInput,
  ctx: PromoteRunContext,
  db: Db,
): Promise<PromoteRunResult> {
  // Refuse pull_request BEFORE minting a claim (mirrors the scratch pre-check):
  // no spurious claiming→failed cycle, no readiness/drift git for an unsupported
  // mode. Phase 3 replaces this with the hybrid gh/glab/Gitea PR adapter.
  if (input.mode === "pull_request") {
    throw new MaisterError("CONFIG", "pull_request promotion lands in Phase 3");
  }

  // ---- Claim tx: short, commits BEFORE any side-effect (§3.2 step 1). The
  // SELECT … FOR UPDATE row lock serializes concurrent claims: the second waits
  // for the first to commit, then sees a fresh `claiming` and is refused.
  const claim = await db.transaction(async (tx: Db) => {
    const workspace = await loadWorkspaceForUpdate(tx, runId);
    const run = await loadRun(tx, runId);

    if (run.status !== "Review") {
      throw new MaisterError(
        "PRECONDITION",
        `flow run must be Review before promotion: ${run.status}`,
      );
    }

    await ctx.authorize(run.projectId);

    // Legacy-row fallback (§3.6): derive a missing target branch from the
    // project's main branch, never a silent null into git. The project row is
    // loaded ONLY when both the request and the workspace snapshot lack a target
    // (pre-M18 row) — the live path never touches it. The promotion MODE is
    // always supplied by the request (required enum), so no project fallback is
    // needed for it.
    let project: any = null;
    const needsTargetFallback = !input.targetBranch && !workspace.targetBranch;

    if (needsTargetFallback) {
      project = await loadProject(tx, run.projectId);
    }

    const resolvedTarget =
      input.targetBranch ??
      workspace.targetBranch ??
      project?.mainBranch ??
      null;

    if (!resolvedTarget) {
      throw new MaisterError(
        "PRECONDITION",
        "legacy run lacks branch metadata — relaunch to promote",
      );
    }

    const resolvedMode = input.mode;

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

    // Target-drift gate (Codex F6, §3.7). The non-UI / blind caller that omits
    // reviewedTargetCommit is refused rather than promoted blind.
    if (!input.allowTargetDrift) {
      if (!input.reviewedTargetCommit) {
        throw new MaisterError(
          "PRECONDITION",
          "reviewedTargetCommit is required (omit only with allowTargetDrift)",
        );
      }

      const liveTip = await resolveBaseCommit({
        projectRepoPath: workspace.parentRepoPath,
        baseRef: resolvedTarget,
      });

      if (liveTip !== input.reviewedTargetCommit) {
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
        promotionOwnerUserId: ctx.sessionUser.id,
        promotionMode: resolvedMode,
        targetBranch: resolvedTarget,
      })
      .where(eq(workspaces.id, workspace.id));

    log.debug(
      { runId, attemptId, resolvedMode, resolvedTarget },
      "promote claim minted",
    );

    return {
      attemptId,
      run,
      workspace,
      resolvedMode,
      resolvedTarget,
      baseCommit: workspace.baseCommit ?? null,
    };
  });

  // ---- Side-effects: NO lock held (§3.2 step 2). resolvedMode is local_merge
  // here — pull_request was refused before the claim was minted.
  let commit: string;

  try {
    commit = await promoteLocalMerge({
      projectRepoPath: claim.workspace.parentRepoPath,
      sourceBranch: claim.workspace.branch,
      targetBranch: claim.resolvedTarget,
    });
  } catch (err) {
    if (isMaisterError(err) && err.code === "CONFLICT") {
      await db.transaction(async (tx: Db) => {
        const ws = await loadWorkspaceForUpdate(tx, runId);

        // Only the owning attempt records the failure (token-matched).
        if (ws.promotionAttemptId !== claim.attemptId) return;
        await createMergeConflictAssignment({
          db: tx,
          run: claim.run,
          workspace: claim.workspace,
          sessionUser: ctx.sessionUser,
          targetBranch: claim.resolvedTarget,
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

  // ---- Finalize tx: assert the attempt token still matches (§3.2 step 3).
  const result = await db.transaction(async (tx: Db) => {
    const ws = await loadWorkspaceForUpdate(tx, runId);

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

    log.info(
      {
        runId,
        mode: "local_merge",
        commit,
        targetBranch: claim.resolvedTarget,
      },
      "flow run promoted to Done",
    );

    return {
      ok: true as const,
      mode: "local_merge" as const,
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
  if (input.mode === "pull_request") {
    throw new MaisterError("CONFIG", "pull_request promotion lands in Phase 3");
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
 * Shared promotion service over both run kinds (M18 Phase 2, ADR-048).
 * Dispatches on `runs.run_kind`. Flow runs get the readiness re-gate +
 * target-drift gate + relaxed target; scratch runs stay target-locked with the
 * M15 merge-readiness guard. Both run through the durable promotion claim (§3.2,
 * Codex F1/F5): claim CAS committed before the side-effect, finalize keyed on
 * the per-attempt `promotion_attempt_id` token.
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

  return promoteFlowRun(runId, input, ctx, d);
}
