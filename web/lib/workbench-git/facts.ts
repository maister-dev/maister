import "server-only";

import type { WorkbenchGitPolicyInput } from "@/lib/workbench-git/policy";

import pino from "pino";

import { isLaunchedLineageRun } from "@/lib/evaluations/membership";
import { getActiveAssignment } from "@/lib/execution-host/assignments";
import { workbenchClaimHolder } from "@/lib/runs/lifecycle-claim";
import { openReworkClaimOwnerUserId } from "@/lib/runs/rework-claim";
import { countUnsettledSharedSiblings } from "@/lib/runs/shared-tree";
import { syncShapeRefusal } from "@/lib/runs/sync-shape";
import { worktreePresence } from "@/lib/workbench-git/presence";
import { publishedTarget } from "@/lib/workbench-git/publication";
import {
  listRemotes,
  localBranchHead,
  remoteTrackingBranchHead,
} from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants — callers pass their own
// drizzle handle (the app client or a test container's).
type Db = any;

const log = pino({
  name: "workbench-git-facts",
  level: process.env.LOG_LEVEL ?? "info",
});

export type WorkbenchGitFactsRun = {
  id: string;
  runKind: "flow" | "scratch" | "agent";
  status: string;
  scratchDialogStatus?: string | null;
  workspaceMode?: string | null;
  agentWorkspace?: string | null;
  rootRunId?: string | null;
  parentRunId?: string | null;
};

export type WorkbenchGitFactsWorkspace = {
  branch: string;
  worktreePath: string;
  parentRepoPath: string;
  removedAt: Date | null;
  archivedBranch: string | null;
  lifecycleOperationState?: string | null;
  lifecycleOperationName?: string | null;
  lifecycleOperationClaimedAt?: Date | null;
  lifecycleOperationLeaseExpiresAt?: Date | null;
  promotionState?: string | null;
  promotionClaimedAt?: Date | null;
  prUrl?: string | null;
  prState?: string | null;
  publishedBranch?: string | null;
  publishedRemote?: string | null;
};

export type ReattachSources = {
  local: string | null;
  published: string | null;
  archive: string | null;
};

export type WorkbenchGitFacts = {
  // Everything the predicate reads except the viewer, who is the caller's.
  policy: Omit<WorkbenchGitPolicyInput, "viewerUserId">;
  claimOwnerUserId: string | null;
  worktreePresent: boolean;
  // The op holding the slot, when another writer owns the tree right now.
  busy: { name: string; claimedAt: Date | null } | null;
  // C14: information only — a parked status is the no-live-writer witness.
  hasActiveAssignment: boolean;
  hasLiveSharedSibling: boolean;
  // null when the probe failed (the policy then treats remotes as not probed).
  remotes: string[] | null;
  // Resolved only when the tree is not usable (all null otherwise).
  reattachSources: ReattachSources;
  // Probes that failed and read as "not probed" (the read model's warnings).
  degraded: Array<"remotes" | "reattachSources">;
};

const NO_SOURCES: ReattachSources = {
  local: null,
  published: null,
  archive: null,
};

function prStateOf(value: string | null | undefined) {
  return value === "open" || value === "merged" || value === "closed"
    ? value
    : null;
}

type Degraded = WorkbenchGitFacts["degraded"];

// A git read that degrades to `null` — a fact the loader could not establish
// must read as "not probed", never throw the caller's request away.
async function probe<T>(
  what: Degraded[number],
  runId: string,
  degraded: Degraded,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    log.warn(
      { runId, what, err: err instanceof Error ? err.message : String(err) },
      "workbench git fact probe failed",
    );
    if (!degraded.includes(what)) degraded.push(what);

    return null;
  }
}

async function resolveReattachSources(
  runId: string,
  workspace: WorkbenchGitFactsWorkspace,
  degraded: Degraded,
): Promise<ReattachSources> {
  const repo = workspace.parentRepoPath;
  const [local, published, archive] = await Promise.all([
    probe("reattachSources", runId, degraded, () =>
      localBranchHead({ projectRepoPath: repo, branch: workspace.branch }),
    ),
    // The revival's own rule (`publishedTarget`): the recorded publication,
    // else a pre-ADR-181 push of the internal name to `origin`.
    probe("reattachSources", runId, degraded, () => {
      const published = publishedTarget(workspace);

      return remoteTrackingBranchHead({
        projectRepoPath: repo,
        remote: published.remote,
        branch: published.remoteBranch,
      });
    }),
    workspace.archivedBranch
      ? probe("reattachSources", runId, degraded, () =>
          localBranchHead({
            projectRepoPath: repo,
            branch: workspace.archivedBranch!,
          }),
        )
      : null,
  ]);

  return { local, published, archive };
}

// ADR-181 D1a: the ONE place the predicate's inputs are assembled. Its callers
// (the lifecycle service's context, the git read model, sync admission and
// finalize) never re-derive a fact this returns.
export async function loadWorkbenchGitFacts(args: {
  db: Db;
  run: WorkbenchGitFactsRun;
  workspace: WorkbenchGitFactsWorkspace | null;
}): Promise<WorkbenchGitFacts> {
  const { db, run, workspace } = args;
  const degraded: Degraded = [];
  const sharedTree =
    run.workspaceMode === "shared" &&
    run.agentWorkspace === "worktree" &&
    typeof run.rootRunId === "string";
  const [claimOwnerUserId, siblings, assignment, presence, remotes, launched] =
    await Promise.all([
      run.status === "HumanWorking"
        ? openReworkClaimOwnerUserId(run.id, db)
        : null,
      sharedTree ? countUnsettledSharedSiblings(db, run.rootRunId!) : 0,
      getActiveAssignment(db, run.id),
      workspace
        ? worktreePresence([workspace.worktreePath])
        : new Map<string, boolean>(),
      workspace
        ? probe("remotes", run.id, degraded, () =>
            listRemotes({ projectRepoPath: workspace.parentRepoPath }),
          )
        : null,
      run.runKind === "scratch" ? false : isLaunchedLineageRun(db, run.id),
    ]);
  const worktreePresent = workspace
    ? presence.get(workspace.worktreePath) === true
    : false;
  const hasLiveSharedSibling = siblings > 0;
  const busy = workspace ? workbenchClaimHolder(workspace) : null;
  const usable =
    workspace !== null && workspace.removedAt === null && worktreePresent;
  const reattachSources =
    workspace && !usable
      ? await resolveReattachSources(run.id, workspace, degraded)
      : NO_SOURCES;
  // No source found is "none" only when every probe answered; a failed probe
  // leaves it unknown, and the revival re-probes (C32).
  const reattachSource = usable
    ? null
    : Object.values(reattachSources).some((sha) => sha !== null)
      ? true
      : degraded.includes("reattachSources")
        ? null
        : false;
  const updateSupported =
    syncShapeRefusal({
      runKind: run.runKind,
      parentRunId: run.parentRunId ?? null,
      workspaceMode: run.workspaceMode ?? null,
      isLaunchedLineage: launched,
    }) === null;

  const facts: WorkbenchGitFacts = {
    policy: {
      runKind: run.runKind,
      runStatus: run.status,
      scratchDialogStatus:
        (run.scratchDialogStatus as WorkbenchGitPolicyInput["scratchDialogStatus"]) ??
        null,
      hasWorkspace: workspace !== null,
      workspaceRemoved: workspace?.removedAt != null,
      workspaceArchived: workspace?.archivedBranch != null,
      claimOwnerUserId,
      worktreePresent: workspace ? worktreePresent : null,
      busy: busy !== null || hasLiveSharedSibling,
      promotionState: workspace?.promotionState ?? null,
      publishedBranch: workspace?.publishedBranch ?? null,
      hasRemote: remotes === null ? null : remotes.length > 0,
      prUrl: workspace?.prUrl ?? null,
      prState: prStateOf(workspace?.prState),
      updateSupported,
      reattachSource,
    },
    claimOwnerUserId,
    worktreePresent,
    busy,
    hasActiveAssignment: assignment !== null,
    hasLiveSharedSibling,
    remotes,
    reattachSources,
    degraded,
  };

  log.debug(
    {
      runId: run.id,
      status: run.status,
      usable,
      busy: busy?.name ?? null,
      hasLiveSharedSibling,
      hasActiveAssignment: facts.hasActiveAssignment,
      updateSupported,
    },
    "workbench git facts loaded",
  );

  return facts;
}
