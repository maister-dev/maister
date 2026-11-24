import type { WorkspaceStatus } from "../../runtime/workspace-prepare";
import type { HostState, WorkspaceRow } from "./host-state";

import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { GIT_OBJECT_ID } from "../../runtime/wait-head";

import { SupervisorError } from "./types";
import { executeWorkspaceGit } from "./workspace-source";

async function readGitHead(workspace: WorkspaceRow): Promise<{
  commit: string;
  ref: string;
}> {
  const identity = await executeWorkspaceGit([
    "--no-optional-locks",
    "-C",
    workspace.realPath,
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
    "HEAD^{commit}",
    "--symbolic-full-name",
    "HEAD",
  ]);
  const [topLevel, commonDirectory, commit, ref, extra] = identity.split("\n");

  if (
    extra !== undefined ||
    workspace.repoPath === null ||
    topLevel !== workspace.realPath ||
    commonDirectory !== join(workspace.repoPath, ".git") ||
    !GIT_OBJECT_ID.test(commit) ||
    (ref !== "HEAD" && !ref.startsWith("refs/heads/"))
  )
    throw new SupervisorError("PRECONDITION", "The checkout identity changed");

  return { commit, ref };
}

/** Inspect only the retained generation owned by this supervisor. */
export async function inspectWorkspace(
  state: HostState,
  handle: string,
  generation: number,
): Promise<WorkspaceStatus | null> {
  const workspace = state.getWorkspace(handle);
  const execution = state.getWorkspaceExecutionState(handle);
  if (!workspace || workspace.releasedAt) return null;
  if (execution?.generation !== generation)
    throw new SupervisorError("FENCED", "Workspace generation has changed", {
      details: { reason: "stale_workspace_generation" },
    });
  const mode = execution.preparationMode;
  if (mode === null)
    throw new SupervisorError(
      "PRECONDITION",
      "Workspace preparation mode has no retained witness",
      {
        details: { reason: "workspace_rejected" },
      },
    );

  const record = { handle, generation, mode };
  try {
    if ((await realpath(workspace.realPath)) !== workspace.realPath)
      throw new SupervisorError("PRECONDITION", "Workspace mount has changed");
    if (workspace.kind === "directory")
      return {
        workspace: { ...record, observedCommit: null },
        workingTree: "nonGit",
        headState: "nonGit",
      };

    const head = await readGitHead(workspace);
    const status = await executeWorkspaceGit([
      "--no-optional-locks",
      "-C",
      workspace.realPath,
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
      "--ignore-submodules=none",
      "-z",
    ]);
    const verified = await readGitHead(workspace);
    if (head.commit !== verified.commit || head.ref !== verified.ref)
      throw new SupervisorError(
        "PRECONDITION",
        "Checkout HEAD moved during status inspection",
      );
    if (
      state.getWorkspace(handle)?.releasedAt !== null ||
      state.getWorkspaceExecutionState(handle)?.generation !== generation
    )
      throw new SupervisorError(
        "PRECONDITION",
        "Workspace ownership changed during status inspection",
      );

    return {
      workspace: { ...record, observedCommit: head.commit },
      workingTree: status ? "dirty" : "clean",
      headState: head.ref === "HEAD" ? "detached" : "branch",
    };
  } catch {
    // Git and filesystem errors can contain private paths. The wire response carries only the handle.
    throw new SupervisorError(
      "PRECONDITION",
      "The supervisor could not verify workspace status",
      {
        details: { reason: "workspace_rejected" },
      },
    );
  }
}
