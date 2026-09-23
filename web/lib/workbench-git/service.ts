import "server-only";

import type { MaisterProvenance } from "@/lib/worktree-provenance";

import { and, eq, gt } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { RELEASED_LIFECYCLE_CLAIM } from "@/lib/runs/lifecycle-claim";
import {
  reviveWorktreeForWorkspace,
  type ReviveSource,
} from "@/lib/runs/revive-worktree";
import { worktreePresence } from "@/lib/workbench-git/presence";
import { publishedTarget } from "@/lib/workbench-git/publication";
import {
  depsFromOptions,
  markLifecycleClaimFailed,
  requireActionAllowed,
  requireWorkspace,
  type LifecycleContext,
  type LifecycleWorkspace,
  type WorkbenchLifecycleOptions,
} from "@/lib/workbench-lifecycle/service";
import {
  discardWorktreeChanges,
  headCommit,
  listWorktrees,
  removeWorktree,
  rescueRestoreCommand,
  writeRescueRef,
} from "@/lib/worktree";
import {
  installWorktreeProvenance,
  readWorktreeProvenanceMetadata,
} from "@/lib/worktree-provenance";

// ADR-181 — the run git panel's own mutations. Each takes the SAME workbench
// lifecycle slot as archive/drop/publish (one writer per worktree, D20) and is
// admitted by the ONE policy (D1) through `requireActionAllowed`.

// FIXME(any): dual drizzle-orm peer-dep variants — mirror sync-target.ts.
const { flows, runs, workspaces } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): the injected db seam is a Drizzle client OR a transaction.
type Db = any;

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

export type ReattachWorkbenchResult = {
  ok: true;
  runId: string;
  source: ReviveSource;
  head: string;
};

// ADR-181 D10 step 5 — the reattach's LAST write, the one its crash window
// hinges on: the row turns usable only after the worktree and its provenance
// exist, and the claim is released in the SAME statement. The op itself
// writes under its live lease; the reconciler completes a crashed attempt
// whose lease lapsed or whose claim failed (C31), fenced on that attempt.
export async function recordReattached(args: {
  database?: Db;
  workspaceId: string;
  attemptId: string;
  liveLease: boolean;
}): Promise<boolean> {
  const client = (args.database ?? getDb()) as Db;
  const rows = await client
    .update(workspaces)
    .set({
      removedAt: null,
      scheduledRemovalAt: null,
      ...RELEASED_LIFECYCLE_CLAIM,
    })
    .where(
      and(
        eq(workspaces.id, args.workspaceId),
        eq(workspaces.lifecycleOperationName, "reattach"),
        eq(workspaces.lifecycleOperationAttemptId, args.attemptId),
        ...(args.liveLease
          ? [
              eq(workspaces.lifecycleOperationState, "claiming"),
              gt(workspaces.lifecycleOperationLeaseExpiresAt, new Date()),
            ]
          : []),
      ),
    )
    .returning({ id: workspaces.id });

  return rows.length > 0;
}

// C31: a directory at the worktree path is adopted only when it is this run's
// own crashed attempt — its provenance names the run AND git registers it as a
// worktree of the parent repo on the internal branch. Anything else is refused
// untouched, and a directory with foreign provenance is refused before any git
// call.
async function adoptsOwnAttempt(
  runId: string,
  workspace: { worktreePath: string; parentRepoPath: string; branch: string },
): Promise<boolean> {
  const present =
    (await worktreePresence([workspace.worktreePath])).get(
      workspace.worktreePath,
    ) === true;

  if (!present) return false;

  const provenance = await readWorktreeProvenanceMetadata(
    workspace.worktreePath,
  ).catch(() => null);
  const own =
    provenance?.runId === runId &&
    (await listWorktrees(workspace.parentRepoPath)).some(
      (entry) =>
        entry.path === workspace.worktreePath &&
        entry.branch === `refs/heads/${workspace.branch}`,
    );

  if (own) return true;

  throw new MaisterError(
    "CONFLICT",
    `the worktree path of run ${runId} is occupied by something that is not its own worktree — nothing was changed`,
    { details: { reason: "worktree_path_occupied" } },
  );
}

// Provenance v2 rebuilt from the database, the shape each launcher stamps
// (`services/runs.ts`, `agents/launch.ts`, `scratch-runs/service.ts`): a flow
// run also names its task and flow revision, which promotion's commit
// trailers read back.
async function reattachProvenance(
  ctx: LifecycleContext,
  workspace: LifecycleWorkspace,
): Promise<MaisterProvenance> {
  const rows = await (getDb() as Db)
    .select({
      createdAt: workspaces.createdAt,
      flowRevision: runs.flowRevision,
      flowRefId: flows.flowRefId,
    })
    .from(workspaces)
    .innerJoin(runs, eq(runs.id, workspaces.runId))
    .leftJoin(flows, eq(flows.id, runs.flowId))
    .where(eq(workspaces.id, workspace.id));
  const row = rows[0];
  const flowRun = ctx.run.runKind === "flow";

  return {
    version: 2,
    runId: ctx.run.id,
    parentRepoPath: workspace.parentRepoPath,
    projectId: ctx.run.projectId,
    branch: workspace.branch,
    workspaceKind: ctx.run.runKind,
    createdAt: new Date(row?.createdAt ?? Date.now()).toISOString(),
    ...(flowRun && ctx.task && ctx.project.taskKey
      ? { task: `${ctx.project.taskKey}-${ctx.task.number}` }
      : {}),
    ...(flowRun && row?.flowRefId
      ? { flow: `${row.flowRefId}@${row.flowRevision}` }
      : {}),
  };
}

// ADR-181 D10 — re-create a removed (or vanished) worktree from the first
// source that resolves (local branch → publication → archive ref). The row
// turns usable LAST, so a crash in between leaves a worktree the reconciler
// completes and a retry adopts (C31), never a usable row without a tree.
export async function reattachWorkbench(
  runId: string,
  options?: WorkbenchGitOptions,
): Promise<ReattachWorkbenchResult> {
  const deps = depsFromOptions(options);
  const sessionUser = await deps.requireActiveSession();
  const ctx = await deps.loadContext(runId);

  ctx.viewerUserId = sessionUser.id;

  await deps.authorize(ctx.run.projectId, "recoverRun");
  requireActionAllowed(ctx, "reattach");

  const workspace = ctx.workspace;

  if (workspace === null) {
    throw new MaisterError(
      "PRECONDITION",
      `workbench run ${runId} has no workspace`,
    );
  }

  const adopting = await adoptsOwnAttempt(runId, workspace);
  const claim = await deps.claimLifecycleOperation({
    runId,
    workspaceId: workspace.id,
    operation: "reattach",
    expectedRunStatus: ctx.run.status,
  });
  // Set once this attempt's `worktree add` landed and cleared again once its
  // provenance names the run: from then on the tree is an adoptable attempt
  // (C31), never an orphan to compensate.
  let unstampedTree = false;

  try {
    const revived = adopting
      ? {
          source: "local" as const,
          head: await headCommit({ worktreePath: workspace.worktreePath }),
        }
      : await reviveWorktreeForWorkspace({
          parentRepoPath: workspace.parentRepoPath,
          worktreePath: workspace.worktreePath,
          branch: workspace.branch,
          published: publishedTarget(workspace),
          archivedBranch: workspace.archivedBranch,
        });

    unstampedTree = !adopting;
    await installWorktreeProvenance({
      worktreePath: workspace.worktreePath,
      metadata: await reattachProvenance(ctx, workspace),
    });
    unstampedTree = false;
    await deps.renewLifecycleOperationLease({
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
    });

    if (
      !(await recordReattached({
        workspaceId: workspace.id,
        attemptId: claim.attemptId,
        liveLease: true,
      }))
    ) {
      throw new MaisterError(
        "CONFLICT",
        `lifecycle operation claim lost for workspace ${workspace.id}`,
      );
    }

    log.info(
      { runId, workspaceId: workspace.id, ...revived, adopted: adopting },
      "workbench re-attached",
    );

    return { ok: true, runId, source: revived.source, head: revived.head };
  } catch (err) {
    log.warn(
      {
        runId,
        workspaceId: workspace.id,
        attemptId: claim.attemptId,
        unstampedTree,
        errorCode: err instanceof MaisterError ? err.code : "unknown",
      },
      "reattach failed",
    );
    // D10 step 4: a tree without provenance is one nothing can trust or adopt —
    // remove the worktree this attempt added (as `addWorktree` compensates).
    // A stamped tree stays for the retry to adopt and the reconciler to finish.
    if (unstampedTree) {
      await removeWorktree({
        projectRepoPath: workspace.parentRepoPath,
        worktreePath: workspace.worktreePath,
        force: true,
      }).catch((cleanupErr: unknown) => {
        log.error(
          {
            runId,
            err:
              cleanupErr instanceof Error
                ? cleanupErr.message
                : String(cleanupErr),
          },
          "reattach failed and its worktree could not be removed",
        );
      });
    }
    await markLifecycleClaimFailed({
      deps,
      workspaceId: workspace.id,
      attemptId: claim.attemptId,
      err,
    });

    throw err;
  }
}
