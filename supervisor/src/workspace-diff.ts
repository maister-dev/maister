import type { WorkspaceInputObject } from "../../runtime/workspace-prepare";
import type { HostState, WorkspaceRow } from "./host-state";
import type { RuntimeEventPublisher } from "./runtime-event-publisher";
import type { RuntimeObjectRegistry } from "./runtime-objects";

import { realpath } from "node:fs/promises";

import { SupervisorError } from "./types";
import { sealWorkspaceOutput } from "./workspace-output-object";
import { withPreparedGitIndex } from "./workspace-git-index";
import {
  executeWorkspaceGit,
  executeWorkspaceGitBytes,
} from "./workspace-source";
import {
  loadPreparedWorkspace,
  observePreparedGitHead,
} from "./workspace-status";

function diffRefusal(): SupervisorError {
  return new SupervisorError(
    "PRECONDITION",
    "The requested diff range is unavailable on this workspace generation",
    {
      details: { reason: "workspace_diff_range_invalid" },
    },
  );
}

async function readWorkingTreePatch(
  workspace: WorkspaceRow,
  git: readonly string[],
  args: readonly string[],
): Promise<Buffer> {
  return withPreparedGitIndex(workspace, git, async (indexFile) => {
    await executeWorkspaceGitBytes([...git, "add", "-N", "--", "."], {
      indexFile,
    });

    return await executeWorkspaceGitBytes(args, { indexFile });
  });
}

/** Capture only commits reachable from the owned checkout and seal the bounded Git patch. */
export async function sealWorkspaceDiff(
  services: Readonly<{
    state: HostState;
    objects: RuntimeObjectRegistry;
    events: RuntimeEventPublisher;
  }>,
  query: Readonly<{
    handle: string;
    generation: number;
    base?: string;
    head?: string;
  }>,
): Promise<{ generation: number; object: WorkspaceInputObject } | null> {
  const { state } = services;
  const { handle, generation } = query;
  const owned = loadPreparedWorkspace(state, handle, generation);
  if (!owned) return null;
  const { workspace } = owned;
  const fence = state.getFence(workspace.runId);
  if (!fence || workspace.kind !== "git_worktree") throw diffRefusal();

  const git = ["--no-optional-locks", "-C", workspace.realPath];
  let base: string;
  let bytes: Buffer;
  try {
    if ((await realpath(workspace.realPath)) !== workspace.realPath)
      throw diffRefusal();
    const observed = await observePreparedGitHead(workspace);
    const head = query.head ?? observed.commit;
    base = query.base ?? head;
    for (const [ancestor, descendant] of [
      [head, observed.commit],
      [base, head],
    ]) {
      if (ancestor !== descendant)
        await executeWorkspaceGit([
          ...git,
          "merge-base",
          "--is-ancestor",
          ancestor,
          descendant,
        ]);
    }
    const args = [
      ...git,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      base,
      ...(query.head ? [query.head] : []),
      "--",
    ];
    bytes = query.head
      ? await executeWorkspaceGitBytes(args)
      : await readWorkingTreePatch(workspace, git, args);
    const verified = await observePreparedGitHead(workspace);
    const currentFence = state.getFence(workspace.runId);
    if (
      verified.commit !== observed.commit ||
      verified.ref !== observed.ref ||
      !loadPreparedWorkspace(state, handle, generation) ||
      currentFence?.assignmentId !== fence.assignmentId ||
      currentFence.epoch !== fence.epoch
    )
      throw diffRefusal();
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code ===
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    )
      throw new SupervisorError(
        "PRECONDITION",
        "The workspace diff exceeds the 64 KiB review limit",
        {
          details: { reason: "workspace_diff_too_large" },
        },
      );
    throw diffRefusal();
  }

  const object = await sealWorkspaceOutput(
    services,
    {
      runId: workspace.runId,
      assignmentId: fence.assignmentId,
      assignmentEpoch: fence.epoch,
    },
    {
      logicalName: "workspace-diff.patch",
      mimeType: "text/x-diff",
      bytes,
      source: {
        workspaceGitDiff: {
          handle,
          generation,
          base,
          head: query.head ?? null,
        },
      },
    },
  );

  return { generation, object };
}
