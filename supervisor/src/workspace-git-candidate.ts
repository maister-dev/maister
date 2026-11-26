import type { WorkspaceSyncRequest } from "../../runtime/workspace-prepare";

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { WORKSPACE_SYNC_CONFLICT_MAX_BYTES, WORKSPACE_SYNC_CONFLICT_MAX_PATHS, WORKSPACE_SYNC_CONFLICT_MAX_PATH_LENGTH } from "../../runtime/workspace-prepare";
import { SupervisorError } from "./types";
import { executeWorkspaceGit, executeWorkspaceGitBytes } from "./workspace-source";

export class WorkspaceCandidateConflict extends SupervisorError {
  constructor(readonly paths: readonly string[]) {
    super("CONFLICT", "The reviewed target conflicts with the retained workspace", {
      details: { reason: "sync_conflict" },
    });
    Object.setPrototypeOf(this, WorkspaceCandidateConflict.prototype);
  }
}

export async function readWorkspaceConflictPaths(git: readonly string[]): Promise<readonly string[]> {
  const conflicts = await executeWorkspaceGitBytes([...git, "diff", "-z", "--name-only", "--diff-filter=U"]);
  if (!conflicts.length) return [];
  const paths = conflicts.toString("utf8").split("\0").slice(0, -1);
  if (paths.length > WORKSPACE_SYNC_CONFLICT_MAX_PATHS ||
    paths.some((path) => path.length > WORKSPACE_SYNC_CONFLICT_MAX_PATH_LENGTH) ||
    Buffer.byteLength(JSON.stringify(paths)) > WORKSPACE_SYNC_CONFLICT_MAX_BYTES ||
    !Buffer.from(paths.join("\0") + "\0", "utf8").equals(conflicts))
    throw syncConflict("sync_conflict", "The conflict report exceeds its supported path or byte limit");
  return paths;
}

export function syncConflict(
  reason:
    | "non_fast_forward"
    | "sync_conflict"
    | "target_ref_changed"
    | "head_changed"
    | "workspace_writer_active",
  message: string,
): SupervisorError {
  return new SupervisorError("CONFLICT", message, { details: { reason } });
}

function exitedWith(error: unknown, status: number): boolean {
  return (error as { code?: unknown }).code === status;
}

export async function commitAt(
  git: readonly string[],
  ref: string,
): Promise<string | null> {
  try {
    return await executeWorkspaceGit([
      ...git,
      "rev-parse",
      "--verify",
      "--quiet",
      ref + "^{commit}",
    ]);
  } catch (error) {
    if (exitedWith(error, 1)) return null;
    throw error;
  }
}

export async function makeSyncCandidate(
  runtimeRoot: string,
  git: readonly string[],
  head: string,
  target: string,
  strategy: WorkspaceSyncRequest["payload"]["strategy"],
): Promise<string> {
  if (head === target) return head;
  try {
    await executeWorkspaceGit([
      ...git,
      "merge-base",
      "--is-ancestor",
      target,
      head,
    ]);
    return head;
  } catch (error) {
    if (!exitedWith(error, 1)) throw error;
  }
  if (strategy === "fastForward") {
    try {
      await executeWorkspaceGit([
        ...git,
        "merge-base",
        "--is-ancestor",
        head,
        target,
      ]);
    } catch (error) {
      if (!exitedWith(error, 1)) throw error;
      throw syncConflict(
        "non_fast_forward",
        "The retained branch cannot fast-forward to the reviewed target",
      );
    }

    return target;
  }

  const temporary = await mkdtemp(join(runtimeRoot, ".workspace-sync-"));
  const checkout = join(temporary, "checkout");
  try {
    await executeWorkspaceGit([
      ...git,
      "worktree",
      "add",
      "--detach",
      "--quiet",
      checkout,
      head,
    ]);
    const isolated = [
      "--no-replace-objects",
      "-C",
      checkout,
      "-c",
      "user.name=MAIster",
      "-c",
      "user.email=supervisor@maister.local",
      "-c",
      "commit.gpgsign=false",
    ];
    try {
      await executeWorkspaceGit([
        ...isolated,
        ...(strategy === "merge"
          ? ["merge", "--no-edit", "--no-ff"]
          : ["rebase"]),
        target,
      ]);

      return await executeWorkspaceGit([...isolated, "rev-parse", "HEAD"]);
    } catch (error) {
      const paths = await readWorkspaceConflictPaths(isolated);
      if (paths.length) throw new WorkspaceCandidateConflict(paths);
      throw error;
    } finally {
      await executeWorkspaceGit([
        ...git,
        "worktree",
        "remove",
        "--force",
        checkout,
      ]);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
