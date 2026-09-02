import "server-only";

import pino from "pino";

import { diffNameStatus, diffWorkingTree } from "@/lib/worktree";

const log = pino({
  name: "workspace-clean",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-165 (D17): "this run changed nothing" — the precondition for result-only
// completion. Both halves are needed and neither is sufficient:
//
//   - `base_commit..branch` covers COMMITTED work. A run that committed and
//     then reverted has an empty working tree but a non-empty range, and it is
//     not clean: the branch carries history a human may want to look at.
//   - the working tree covers UNCOMMITTED work, intent-to-add included. A run
//     that wrote files without committing has an empty range but is not clean.
//
// A NULL `base_commit` is NOT clean. It is the branch point every committed-diff
// comparison is measured from; without it there is no range to call empty, and
// guessing one would silently discard whatever the run did.

export type WorkspaceCleanArgs = {
  worktreePath: string | null;
  branch: string | null;
  baseCommit: string | null;
};

export type WorkspaceCleanResult = {
  clean: boolean;
  /** Why it is not clean — one of the two halves, or a missing precondition. */
  reason:
    | "clean"
    | "no_worktree"
    | "no_base_commit"
    | "committed_diff"
    | "dirty_tree"
    | "probe_failed";
};

export async function isRunWorkspaceClean(
  args: WorkspaceCleanArgs,
): Promise<WorkspaceCleanResult> {
  if (!args.worktreePath || !args.branch) {
    return { clean: false, reason: "no_worktree" };
  }
  if (!args.baseCommit) {
    return { clean: false, reason: "no_base_commit" };
  }

  try {
    const committed = await diffNameStatus({
      worktreePath: args.worktreePath,
      baseRef: args.baseCommit,
      branch: args.branch,
    });

    if (committed.length > 0) {
      return { clean: false, reason: "committed_diff" };
    }

    const working = await diffWorkingTree(args.worktreePath, "HEAD");

    if (working.text.trim().length > 0) {
      return { clean: false, reason: "dirty_tree" };
    }

    return { clean: true, reason: "clean" };
  } catch (err) {
    // Fail CLOSED. A probe that cannot answer must not be read as "nothing
    // changed" — that would let a run with real work skip Review entirely. The
    // run simply takes the ordinary Review exit, which is always safe.
    log.warn(
      {
        worktreePath: args.worktreePath,
        branch: args.branch,
        err: (err as Error).message,
      },
      "[run-result.terminal] clean probe failed — treating the workspace as dirty",
    );

    return { clean: false, reason: "probe_failed" };
  }
}
