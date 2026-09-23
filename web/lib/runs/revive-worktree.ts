import "server-only";

import type { PublishedTarget } from "@/lib/workbench-git/publication";

import pino from "pino";

import { MaisterError } from "@/lib/errors";
import {
  addWorktreeForBranch,
  createLocalBranchAt,
  fetchRemote,
  getRemoteUrl,
  localBranchHead,
  remoteTrackingBranchHead,
  setBranchUpstream,
} from "@/lib/worktree";

const log = pino({
  name: "revive-worktree",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ReviveSource = "local" | "published" | "archive";

// ADR-181 D10 — the ONE revival of a removed worktree, shared by reattach and
// reopen; each caller keeps its own row write (C7). The internal branch comes
// from the first source that resolves: the local branch, then the branch as it
// was published, then the preservation archive ref. Git only — nothing here
// touches the database.
export async function reviveWorktreeForWorkspace(args: {
  parentRepoPath: string;
  worktreePath: string;
  branch: string;
  // Where the branch lives on a remote (`publishedTarget`): the recorded
  // publication, else the pre-ADR-181 shape (`origin`, the internal name).
  published: PublishedTarget;
  archivedBranch: string | null;
}): Promise<{ source: ReviveSource; head: string }> {
  const repo = args.parentRepoPath;
  let source: ReviveSource = "local";
  let head = await localBranchHead({
    projectRepoPath: repo,
    branch: args.branch,
  });

  if (head === null) {
    head = await publishedHead(repo, args.published);

    if (head !== null) {
      await createLocalBranchAt(repo, args.branch, head);
      // The next publish then keeps the name the branch already has (D4).
      await setBranchUpstream(repo, args.branch, {
        remote: args.published.remote,
        branch: args.published.remoteBranch,
      });
      source = "published";
    }
  }

  if (head === null && args.archivedBranch) {
    head = await localBranchHead({
      projectRepoPath: repo,
      branch: args.archivedBranch,
    });

    if (head !== null) {
      await createLocalBranchAt(repo, args.branch, head);
      source = "archive";
    }
  }

  if (head === null) {
    throw new MaisterError(
      "PRECONDITION",
      `nothing to re-attach ${args.branch} from — the local branch, its publication and the archive ref are all gone`,
      { details: { reason: "no_reattach_source" } },
    );
  }

  await addWorktreeForBranch(repo, args.worktreePath, args.branch);
  log.info(
    { branch: args.branch, worktreePath: args.worktreePath, source, head },
    "worktree revived",
  );

  return { source, head };
}

// A remote that is not configured is no source. A failed fetch is transient
// (`EXECUTOR_UNAVAILABLE`, retryable) — never a revival from whatever stale
// head the last fetch left in the tracking ref.
async function publishedHead(
  repo: string,
  published: PublishedTarget,
): Promise<string | null> {
  if (
    (await getRemoteUrl({ projectRepoPath: repo, name: published.remote })) ===
    null
  ) {
    return null;
  }

  await fetchRemote({ projectRepoPath: repo, name: published.remote });

  return remoteTrackingBranchHead({
    projectRepoPath: repo,
    remote: published.remote,
    branch: published.remoteBranch,
  });
}
