import "server-only";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { loadWorkbenchGitFacts } from "@/lib/workbench-git/facts";
import {
  deriveWorkbenchGitActions,
  type WorkbenchGitAction,
} from "@/lib/workbench-git/policy";
import { resolvePublishName } from "@/lib/workbench-git/publication";
import { pullRequestDefaults } from "@/lib/workbench-git/pull-request";
import { resolveSyncRef, type SyncOnto } from "@/lib/runs/sync-ref";
import {
  aheadBehindCounts,
  branchUpstream,
  headCommit,
  listRescueRefs,
  localBranchHead,
  remoteBranchHead,
  remoteTrackingBranchHead,
  rescueRestoreCommand,
  statusPorcelain,
  type BranchUpstream,
  type RescueRef,
} from "@/lib/worktree";

// ADR-181 D3 — the LAZY git read model of one run worktree: ~10 local git reads
// plus ONE best-effort network read. Served only by `GET /git-state` (a grep
// control pins that no page loader imports it). Every sub-read degrades to null
// and is named in `warnings` — a git hiccup is never a route error.

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const { projects, runs, scratchRuns, tasks, workspaces } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "workbench-git-read-model",
  level: process.env.LOG_LEVEL ?? "info",
});

export type GitAheadBehind = { ahead: number; behind: number } | null;

export type GitStateWarning =
  | "head"
  | "targetHead"
  | "dirty"
  | "upstream"
  | "remotes"
  | "aheadBehind.base"
  | "aheadBehind.target"
  | "aheadBehind.published"
  | "unpushedCommits"
  | "publishedRemoteHead"
  | "reattachSources"
  | "rescueRefs";

export type GitStateResponse = {
  runId: string;
  runKind: "flow" | "scratch" | "agent";
  runStatus: string;
  internalBranch: string | null;
  publicBranch: string | null;
  publishedRemote: string | null;
  publishedAt: string | null;
  suggestedPublicBranch: string | null;
  upstream: BranchUpstream | null;
  remotes: string[];
  worktreePresent: boolean;
  workspaceRemoved: boolean;
  head: string | null;
  targetHead: string | null;
  dirty: { tracked: number; untracked: number } | null;
  unpushedCommits: number | null;
  aheadBehind: {
    base: GitAheadBehind;
    target: GitAheadBehind;
    published: GitAheadBehind;
  };
  publishedRemoteHead: string | null;
  // The local tracking ref of the publication; differing from
  // `publishedRemoteHead` means the remote moved since the last fetch.
  publishedTrackingHead: string | null;
  remoteReachable: boolean;
  pr: {
    url: string;
    number: number | null;
    state: "open" | "merged" | "closed" | null;
    hasConflicts: boolean | null;
  } | null;
  busy: { name: string; claimedAt: string | null } | null;
  hasActiveAssignment: boolean;
  hasLiveSharedSibling: boolean;
  reattachSources: {
    local: string | null;
    published: string | null;
    archive: string | null;
  };
  rescueRefs: RescueRef[];
  actions: WorkbenchGitAction[];
  prDefaults: { title: string; body: string; targetBranch: string } | null;
  commands: { checkout: string[]; restoreRescue: string | null };
  warnings: GitStateWarning[];
};

function prStateOf(value: unknown): "open" | "merged" | "closed" | null {
  return value === "open" || value === "merged" || value === "closed"
    ? value
    : null;
}

// Porcelain v1: `??` is untracked; every other entry is a tracked change.
function dirtyCounts(porcelain: string): {
  tracked: number;
  untracked: number;
} {
  let tracked = 0;
  let untracked = 0;

  for (const line of porcelain.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith("??")) untracked += 1;
    else tracked += 1;
  }

  return { tracked, untracked };
}

async function loadRows(db: Db, runId: string) {
  const runRows = await db.select().from(runs).where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run || !run.projectId) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`, {
      details: { reason: "run_not_found" },
    });
  }

  const [projectRows, workspaceRows, taskRows, scratchRows] = await Promise.all(
    [
      db.select().from(projects).where(eq(projects.id, run.projectId)),
      db.select().from(workspaces).where(eq(workspaces.runId, runId)),
      run.taskId
        ? db
            .select({ number: tasks.number, title: tasks.title })
            .from(tasks)
            .where(eq(tasks.id, run.taskId))
        : Promise.resolve([]),
      run.runKind === "scratch"
        ? db
            .select({
              baseBranch: scratchRuns.baseBranch,
              targetBranch: scratchRuns.targetBranch,
              dialogStatus: scratchRuns.dialogStatus,
            })
            .from(scratchRuns)
            .where(eq(scratchRuns.runId, runId))
        : Promise.resolve([]),
    ],
  );

  return {
    run,
    project: projectRows[0] ?? null,
    workspace: workspaceRows[0] ?? null,
    task: (taskRows[0] ?? null) as { number: number; title: string } | null,
    scratch: (scratchRows[0] ?? null) as {
      baseBranch: string | null;
      targetBranch: string | null;
      dialogStatus: string | null;
    } | null,
  };
}

export async function loadGitState(args: {
  runId: string;
  viewerUserId: string;
  // The request origin — the PR body's run link (no public-URL setting exists).
  origin: string;
  db?: Db;
}): Promise<GitStateResponse> {
  const db = args.db ?? getDb();
  const { run, project, workspace, task, scratch } = await loadRows(
    db,
    args.runId,
  );
  const warnings: GitStateWarning[] = [];
  const read = async <T>(
    field: GitStateWarning,
    fn: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      log.warn(
        {
          runId: args.runId,
          field,
          err: err instanceof Error ? err.message : String(err),
        },
        "git-state sub-read degraded",
      );
      if (!warnings.includes(field)) warnings.push(field);

      return null;
    }
  };

  const facts = await loadWorkbenchGitFacts({
    db,
    run: {
      id: run.id,
      runKind: run.runKind,
      status: run.status,
      scratchDialogStatus: scratch?.dialogStatus ?? null,
      workspaceMode: run.workspaceMode,
      agentWorkspace: run.agentWorkspace,
      rootRunId: run.rootRunId,
      parentRunId: run.parentRunId,
    },
    workspace,
  });

  for (const field of facts.degraded) warnings.push(field);

  const actions = deriveWorkbenchGitActions({
    ...facts.policy,
    viewerUserId: args.viewerUserId,
  });
  const mainBranch: string = project?.mainBranch ?? "main";
  // D3: scratch base/target live on `scratch_runs` (the workspace row has none).
  const targetBranch: string =
    run.runKind === "scratch"
      ? (scratch?.targetBranch ?? scratch?.baseBranch ?? mainBranch)
      : (workspace?.targetBranch ?? mainBranch);
  const publicBranch: string | null = workspace?.publishedBranch ?? null;
  const publishedRemote: string | null = workspace?.publishedRemote ?? null;
  // ADR-181 D9: an update's ahead/behind is counted against the very ref that
  // update applies onto (`resolveSyncRef` — null where it would refuse). A
  // scratch run cannot update, so it keeps its `scratch_runs` refs (D3).
  const countRef = (
    onto: SyncOnto,
    scratchRef: string | null,
  ): string | null => {
    if (run.runKind === "scratch" || workspace === null) return scratchRef;
    try {
      return resolveSyncRef(onto, run.id, workspace, project).ref;
    } catch {
      return null;
    }
  };
  const baseRef = countRef("base", scratch?.baseBranch ?? null);
  const targetRef = countRef("target", targetBranch);
  const publishedRef = countRef(
    "published",
    publicBranch && publishedRemote
      ? `refs/remotes/${publishedRemote}/${publicBranch}`
      : null,
  );
  const remotes = facts.remotes ?? [];
  const usable =
    workspace !== null && workspace.removedAt === null && facts.worktreePresent;
  const taskKey =
    task && project?.taskKey ? `${project.taskKey}-${task.number}` : null;

  const empty = {
    upstream: null as BranchUpstream | null,
    head: null as string | null,
    targetHead: null as string | null,
    dirty: null as { tracked: number; untracked: number } | null,
    base: null as GitAheadBehind,
    target: null as GitAheadBehind,
    published: null as GitAheadBehind,
    trackingHead: null as string | null,
    publishedRemoteHead: null as string | null,
    remoteReachable: true,
    rescueRefs: [] as RescueRef[],
  };
  const git = { ...empty };

  if (workspace) {
    const repo: string = workspace.parentRepoPath;
    const wt: string = workspace.worktreePath;

    const [upstream, targetHead, rescueRefs, trackingHead] = await Promise.all([
      read("upstream", () => branchUpstream(repo, workspace.branch)),
      read("targetHead", () =>
        localBranchHead({ projectRepoPath: repo, branch: targetBranch }),
      ),
      read("rescueRefs", () =>
        listRescueRefs({ projectRepoPath: repo, runId: run.id }),
      ),
      publicBranch && publishedRemote
        ? read("aheadBehind.published", () =>
            remoteTrackingBranchHead({
              projectRepoPath: repo,
              remote: publishedRemote,
              branch: publicBranch,
            }),
          )
        : null,
    ]);

    git.upstream = upstream;
    git.targetHead = targetHead;
    git.rescueRefs = (rescueRefs ?? []).slice().reverse();
    git.trackingHead = trackingHead;

    if (usable) {
      const [head, porcelain, base, target, published] = await Promise.all([
        read("head", () => headCommit({ worktreePath: wt })),
        read("dirty", () => statusPorcelain({ worktreePath: wt })),
        baseRef
          ? read("aheadBehind.base", () =>
              aheadBehindCounts(wt, baseRef, "HEAD"),
            )
          : null,
        targetRef
          ? read("aheadBehind.target", () =>
              aheadBehindCounts(wt, targetRef, "HEAD"),
            )
          : null,
        trackingHead && publishedRef
          ? read("aheadBehind.published", () =>
              aheadBehindCounts(wt, publishedRef, "HEAD"),
            )
          : null,
      ]);

      git.head = head;
      git.dirty = porcelain === null ? null : dirtyCounts(porcelain);
      git.base = base;
      git.target = target;
      git.published = published;
    }

    // D3: the ONE network read — best effort, the tracking ref answers the
    // local questions whatever it says.
    if (publicBranch && publishedRemote) {
      try {
        git.publishedRemoteHead = await remoteBranchHead({
          projectRepoPath: repo,
          remote: publishedRemote,
          branch: publicBranch,
        });
      } catch (err) {
        git.remoteReachable = false;
        warnings.push("publishedRemoteHead");
        log.warn(
          {
            runId: args.runId,
            remote: publishedRemote,
            err: err instanceof Error ? err.message : String(err),
          },
          "git-state ls-remote failed; degrading",
        );
      }
    }
  }

  let suggestedPublicBranch: string | null = null;

  if (workspace) {
    const remote =
      publishedRemote ??
      (remotes.includes("origin") ? "origin" : (remotes[0] ?? "origin"));

    try {
      suggestedPublicBranch = resolvePublishName({
        runId: run.id,
        internalBranch: workspace.branch,
        remote,
        requested: null,
        template: project?.publicBranchTemplate,
        taskKey,
        taskTitle: task?.title ?? null,
        recordedBranch: publicBranch,
        recordedRemote: publishedRemote,
        legacyPrHead: workspace.prUrl != null && publicBranch === null,
        upstream: git.upstream,
      }).name;
    } catch (err) {
      log.warn(
        {
          runId: args.runId,
          err: err instanceof Error ? err.message : String(err),
        },
        "git-state: no public name resolves (the publish needs a branchName)",
      );
    }
  }

  const newestRescue = git.rescueRefs[0] ?? null;

  const state: GitStateResponse = {
    runId: run.id,
    runKind: run.runKind,
    runStatus: run.status,
    internalBranch: workspace?.branch ?? null,
    publicBranch,
    publishedRemote,
    publishedAt: workspace?.publishedAt
      ? new Date(workspace.publishedAt).toISOString()
      : null,
    suggestedPublicBranch,
    upstream: git.upstream,
    remotes,
    worktreePresent: facts.worktreePresent,
    workspaceRemoved: workspace?.removedAt != null,
    head: git.head,
    targetHead: git.targetHead,
    dirty: git.dirty,
    // Commits HEAD carries that the published tracking ref does not.
    unpushedCommits: git.published?.ahead ?? null,
    aheadBehind: {
      base: git.base,
      target: git.target,
      published: git.published,
    },
    publishedRemoteHead: git.publishedRemoteHead,
    publishedTrackingHead: git.trackingHead,
    remoteReachable: git.remoteReachable,
    pr: workspace?.prUrl
      ? {
          url: workspace.prUrl,
          number: workspace.prNumber ?? null,
          state: prStateOf(workspace.prState),
          hasConflicts: workspace.prHasConflicts ?? null,
        }
      : null,
    busy: facts.busy
      ? {
          name: facts.busy.name,
          claimedAt: facts.busy.claimedAt
            ? new Date(facts.busy.claimedAt).toISOString()
            : null,
        }
      : null,
    hasActiveAssignment: facts.hasActiveAssignment,
    hasLiveSharedSibling: facts.hasLiveSharedSibling,
    reattachSources: facts.reattachSources,
    rescueRefs: git.rescueRefs,
    actions,
    // C35: the same defaults `openPullRequest` applies when the body omits them.
    prDefaults: workspace
      ? {
          ...pullRequestDefaults({
            run,
            internalBranch: workspace.branch,
            sourceBranch:
              publicBranch ?? suggestedPublicBranch ?? workspace.branch,
            targetBranch,
            taskKey,
            taskTitle: task?.title ?? null,
            origin: args.origin,
          }),
          targetBranch,
        }
      : null,
    commands: {
      checkout:
        workspace && publicBranch && publishedRemote
          ? [
              `git -C ${workspace.parentRepoPath} fetch ${publishedRemote} ${publicBranch}`,
              `git -C ${workspace.parentRepoPath} switch --track ${publishedRemote}/${publicBranch}`,
            ]
          : [],
      restoreRescue:
        workspace && newestRescue && facts.worktreePresent
          ? rescueRestoreCommand(workspace.worktreePath, newestRescue.ref)
          : null,
    },
    warnings,
  };

  log.debug(
    {
      runId: args.runId,
      usable,
      publicBranch,
      warnings,
      enabled: actions.filter((a) => a.enabled).map((a) => a.id),
    },
    "git-state loaded",
  );

  return state;
}

// The project a run belongs to, for the route's authorization — before any git.
export async function gitStateProjectId(
  runId: string,
  db?: Db,
): Promise<string> {
  const rows = await (db ?? getDb())
    .select({ projectId: runs.projectId })
    .from(runs)
    .where(eq(runs.id, runId));

  if (!rows[0]?.projectId) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`, {
      details: { reason: "run_not_found" },
    });
  }

  return rows[0].projectId as string;
}
