import "server-only";

import pino from "pino";

import { MaisterError } from "@/lib/errors";
import {
  depsFromOptions,
  markLifecycleClaimFailed,
  requireActionAllowed,
  requireWorkspace,
  type WorkbenchLifecycleOptions,
} from "@/lib/workbench-lifecycle/service";
import {
  discardWorktreeChanges,
  rescueRestoreCommand,
  writeRescueRef,
} from "@/lib/worktree";

// ADR-181 — the run git panel's own mutations. Each takes the SAME workbench
// lifecycle slot as archive/drop/publish (one writer per worktree, D20) and is
// admitted by the ONE policy (D1) through `requireActionAllowed`.

const log = pino({
  name: "workbench-git",
  level: process.env.LOG_LEVEL ?? "info",
});

export type WorkbenchGitDeps = {
  writeRescueRef: typeof writeRescueRef;
  discardWorktreeChanges: typeof discardWorktreeChanges;
};

export type WorkbenchGitOptions = WorkbenchLifecycleOptions & {
  gitDeps?: WorkbenchGitDeps;
};

export type DiscardWorkbenchChangesResult = {
  ok: true;
  runId: string;
  rescueRef: string;
  sha: string;
  restoreCommand: string;
};

function gitDepsFromOptions(options?: WorkbenchGitOptions): WorkbenchGitDeps {
  return options?.gitDeps ?? { writeRescueRef, discardWorktreeChanges };
}

// ADR-181 D8 — discard is PRESERVE-FIRST: every change (staged, unstaged,
// untracked) is written to `refs/maister/rescue/<runId>/<n>` through a copied
// index BEFORE the tree is reset, so a crash between the two leaves the work
// both in the tree and in the ref, and a retry writes `#n+1`.
export async function discardWorkbenchChanges(
  runId: string,
  options?: WorkbenchGitOptions,
): Promise<DiscardWorkbenchChangesResult> {
  const deps = depsFromOptions(options);
  const git = gitDepsFromOptions(options);
  const sessionUser = await deps.requireActiveSession();
  const ctx = await deps.loadContext(runId);

  ctx.viewerUserId = sessionUser.id;

  await deps.authorize(ctx.run.projectId, "promoteRun");
  requireActionAllowed(ctx, "discardChanges");

  const workspace = requireWorkspace(ctx);
  const porcelain = await deps.statusPorcelain({
    worktreePath: workspace.worktreePath,
  });

  if (porcelain.trim() === "") {
    throw new MaisterError(
      "PRECONDITION",
      `worktree is clean for run ${runId}; nothing to discard`,
      { details: { reason: "clean_worktree" } },
    );
  }

  const claim = await deps.claimLifecycleOperation({
    runId,
    workspaceId: workspace.id,
    operation: "discardChanges",
    expectedRunStatus: ctx.run.status,
  });

  try {
    const rescue = await git.writeRescueRef({
      worktreePath: workspace.worktreePath,
      runId,
    });

    log.info(
      {
        runId,
        workspaceId: workspace.id,
        rescueRef: rescue.ref,
        sha: rescue.sha,
      },
      "discard-changes rescue ref written; resetting the tree",
    );

    await git.discardWorktreeChanges(workspace.worktreePath);
    await deps.renewLifecycleOperationLease({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
    });
    await deps.finalizeLifecycleOperation({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      state: "done",
    });

    return {
      ok: true,
      runId,
      rescueRef: rescue.ref,
      sha: rescue.sha,
      restoreCommand: rescueRestoreCommand(workspace.worktreePath, rescue.ref),
    };
  } catch (err) {
    log.warn(
      {
        runId,
        workspaceId: workspace.id,
        attemptId: claim.attemptId,
        errorCode: err instanceof MaisterError ? err.code : "unknown",
      },
      "discard-changes failed",
    );
    await markLifecycleClaimFailed({
      deps,
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      err,
    });

    throw err;
  }
}
