import type { WorkspaceRow } from "./host-state";

import { copyFile, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SupervisorError } from "./types";
import { isUnderRoot } from "./workspace-roots";
import { executeWorkspaceGit } from "./workspace-source";

/** Preserve tracked ignored files and index flags without changing the live index. */
export async function withPreparedGitIndex<T>(
  workspace: WorkspaceRow,
  git: readonly string[],
  use: (indexFile: string) => Promise<T>,
): Promise<T> {
  const index = await executeWorkspaceGit([
    ...git,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]);
  if (
    !workspace.repoPath ||
    !isUnderRoot(join(workspace.repoPath, ".git", "worktrees"), index) ||
    (await realpath(index)) !== index
  )
    throw new SupervisorError(
      "PRECONDITION",
      "The prepared workspace index has changed",
      {
        details: { reason: "workspace_rejected" },
      },
    );
  const directory = await mkdtemp(join(tmpdir(), "maister-owned-index-"));
  const indexFile = join(directory, "index");
  try {
    await copyFile(index, indexFile);
    // A new copy can hide a same-mtime edit behind cached stat entries.
    // Age only the copy so Git rehashes racy entries. Git reserves zero.
    await utimes(indexFile, 1, 1);

    return await use(indexFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
