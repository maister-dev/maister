import type {
  PreparedWorkspace,
  WorkspacePrepareRequest,
} from "../../runtime/workspace-prepare";
import type { HostState, WorkspaceRow } from "./host-state";
import type { WorkspaceRegistry } from "./workspace-registry";

import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { GIT_OBJECT_ID } from "../../runtime/wait-head";
import { workspaceEvidenceDigest } from "../../runtime/workspace-prepare";

import { withSqliteFileLock } from "./sqlite-file-lock";
import { SupervisorError } from "./types";
import { executeWorkspaceGit } from "./workspace-source";
import { isUnderRoot } from "./workspace-roots";

function workspaceRefused(message: string): SupervisorError {
  return new SupervisorError("PRECONDITION", message, {
    details: { reason: "workspace_rejected" },
  });
}

async function realDirectory(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || (await realpath(path)) !== path)
      throw workspaceRefused(
        "workspace path does not name a canonical private directory",
      );

    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function privateDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!isUnderRoot(parent, path) || !(await realDirectory(path)))
    throw workspaceRefused("workspace directory escaped its private root");

  return path;
}

async function withRepositoryCache<T>(
  source: string,
  managedRoot: string,
  use: (repositoryPath: string) => Promise<T>,
  assertOwner?: () => void,
): Promise<T> {
  const cacheKey = workspaceEvidenceDigest(source);
  const repositoryRoot = await privateDirectory(managedRoot, "repositories");

  return withSqliteFileLock(join(repositoryRoot, cacheKey), async () => {
    assertOwner?.();
    const repositoryPath = join(repositoryRoot, cacheKey);
    if (!(await realDirectory(repositoryPath))) {
      await mkdir(repositoryPath, { mode: 0o700 });
      await executeWorkspaceGit(["-C", repositoryPath, "init", "-q"]);
      await executeWorkspaceGit([
        "-C",
        repositoryPath,
        "remote",
        "add",
        "origin",
        source,
      ]);
    }
    const origin = await executeWorkspaceGit([
      "-C",
      repositoryPath,
      "remote",
      "get-url",
      "--all",
      "origin",
    ]);
    if (origin !== source)
      throw workspaceRefused(
        "the private Git cache no longer matches its approved source",
      );

    return use(repositoryPath);
  });
}

async function fetchWorkspaceCommit(
  repositoryPath: string,
  commit: string,
): Promise<void> {
  try {
    await executeWorkspaceGit([
      "-C",
      repositoryPath,
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--",
      "origin",
      commit,
    ]);
  } catch {
    throw new SupervisorError(
      "PRECONDITION",
      "The pinned commit could not be fetched from the approved Git source",
      { details: { reason: "source_commit_unavailable" } },
    );
  }
}

export async function verifyWorkspaceSourcePin(
  input: Readonly<{
    runtimeRoot: string;
    source: string;
    commit: string;
    pin: string;
  }>,
): Promise<string> {
  const { runtimeRoot, source, commit, pin } = input;
  if (pin.toLowerCase() === commit) return commit;
  const managedRoot = await privateDirectory(
    await realpath(runtimeRoot),
    "managed-workspaces",
  );

  return withRepositoryCache(source, managedRoot, async (repositoryPath) => {
    await fetchWorkspaceCommit(repositoryPath, commit);
    try {
      const resolved = await executeWorkspaceGit([
        "-C",
        repositoryPath,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${pin}^{commit}`,
      ]);
      if (!GIT_OBJECT_ID.test(resolved))
        throw workspaceRefused("The pin is not a Git commit");
      await executeWorkspaceGit([
        "-C",
        repositoryPath,
        "merge-base",
        "--is-ancestor",
        resolved,
        commit,
      ]);

      return resolved;
    } catch {
      throw new SupervisorError(
        "PRECONDITION",
        "The pinned commit is unresolved or outside the approved branch history",
        { details: { reason: "source_commit_unavailable" } },
      );
    }
  });
}

export async function prepareGitWorktree(args: {
  source: string;
  managedRoot: string;
  workspacePath: string;
  commit: string;
  assertOwner: () => void;
}): Promise<{ path: string; repositoryPath: string; observedCommit: string }> {
  const { source, managedRoot, workspacePath, commit, assertOwner } = args;

  return withRepositoryCache(source, managedRoot, async (repositoryPath) => {
    assertOwner();
    if (!(await realDirectory(workspacePath))) {
      await fetchWorkspaceCommit(repositoryPath, commit);
      const kind = await executeWorkspaceGit([
        "-C",
        repositoryPath,
        "cat-file",
        "-t",
        commit,
      ]);
      if (kind !== "commit")
        throw workspaceRefused("the pinned Git object is not a commit");
      assertOwner();
      await executeWorkspaceGit([
        "-C",
        repositoryPath,
        "worktree",
        "add",
        "--detach",
        "--",
        workspacePath,
        commit,
      ]);
    }

    const [observedCommit, commonDirectory] = await Promise.all([
      executeWorkspaceGit([
        "-C",
        workspacePath,
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ]),
      executeWorkspaceGit([
        "-C",
        workspacePath,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    ]);
    if (
      observedCommit !== commit ||
      commonDirectory !== join(repositoryPath, ".git")
    )
      throw workspaceRefused(
        "the retained worktree differs from the pinned Git source",
      );

    return { path: workspacePath, repositoryPath, observedCommit };
  }, assertOwner);
}

async function reuseSharedRoot(
  state: HostState,
  parentHandle: string,
  parentGeneration: number,
): Promise<WorkspaceRow> {
  const workspace = state.getWorkspace(parentHandle);
  const execution = state.getWorkspaceExecutionState(parentHandle);
  if (
    !workspace?.repoPath ||
    workspace.kind !== "git_worktree" ||
    workspace.releasedAt ||
    !execution?.inputDigest ||
    execution.generation !== parentGeneration ||
    !(await realDirectory(workspace.realPath))
  )
    throw workspaceRefused(
      "the shared root no longer matches its retained generation",
    );

  return workspace;
}

export async function prepareOwnedWorkspace(args: {
  request: WorkspacePrepareRequest;
  source: string | null;
  state: HostState;
  registry: WorkspaceRegistry;
  runtimeRoot: string;
  assertOwner: () => void;
}): Promise<PreparedWorkspace> {
  const { request, source, state, registry, runtimeRoot, assertOwner } = args;
  const { payload, owner } = request;
  const canonicalRuntimeRoot = await realpath(runtimeRoot);
  const managedPath = join(
    canonicalRuntimeRoot,
    ".maister",
    "managed-workspaces",
  );
  if (!registry.roots.some((root) => isUnderRoot(root, managedPath)))
    throw workspaceRefused(
      "managed workspace root is outside the configured host roots",
    );
  const managedRoot = await privateDirectory(
    await privateDirectory(canonicalRuntimeRoot, ".maister"),
    "managed-workspaces",
  );
  const directory = await privateDirectory(managedRoot, "runs");
  const workspacePath = join(
    directory,
    workspaceEvidenceDigest([owner.runId, request.command.id]),
  );
  let path = workspacePath;
  let repositoryPath: string | undefined;
  let observedCommit: string | null = null;
  let kind: "directory" | "git_worktree" = "directory";
  let projectSlug = "addressed";

  assertOwner();
  if (payload.mode === "ownWorktree" || payload.mode === "readOnlyCheckout") {
    if (!source)
      throw workspaceRefused(
        "the repository is not approved on this supervisor",
      );
    const prepared = await prepareGitWorktree({
      source,
      managedRoot,
      workspacePath,
      commit: payload.commit,
      assertOwner,
    });
    repositoryPath = prepared.repositoryPath;
    observedCommit = prepared.observedCommit;
    projectSlug = payload.repositoryId;
    kind = "git_worktree";
  } else if (payload.mode === "sharedWorktree") {
    const parent = await reuseSharedRoot(
      state,
      payload.parentHandle,
      payload.parentGeneration,
    );
    path = parent.realPath;
    repositoryPath = parent.repoPath ?? undefined;
    projectSlug = parent.projectSlug;
    kind = "git_worktree";
    observedCommit = await executeWorkspaceGit([
      "-C",
      path,
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    if (!GIT_OBJECT_ID.test(observedCommit))
      throw workspaceRefused("the shared root has no verified Git HEAD");
  } else if (payload.mode === "directory") {
    if (!source)
      throw workspaceRefused("the directory profile is not approved");
    path = await realpath(source);
  } else {
    await privateDirectory(
      directory,
      workspacePath.slice(directory.length + 1),
    );
  }

  const lockDirectory = await privateDirectory(managedRoot, "locks");

  return withSqliteFileLock(
    join(lockDirectory, workspaceEvidenceDigest(path)),
    async () => {
      assertOwner();
      if (payload.mode === "directory") {
        const existing = state.activeWorkspacePathOwner(path);
        if (existing && existing.runId !== owner.runId)
          throw workspaceRefused(
            "the directory already has an active workspace owner",
          );
      }
      const { handle } = await registry.adopt({
        runId: owner.runId,
        projectSlug,
        kind,
        path,
        ...(repositoryPath === undefined ? {} : { repoPath: repositoryPath }),
      });
      assertOwner();
      state.recordWorkspaceInput(
        handle.id,
        1,
        payload.inputDigest,
        payload.mode,
      );

      return {
        workspace: {
          handle: handle.id,
          generation: 1,
          mode: payload.mode,
          observedCommit,
        },
        inputDigest: payload.inputDigest,
      };
    },
  );
}
