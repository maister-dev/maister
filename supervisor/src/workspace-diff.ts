import type {
  WorkspaceDiffQuery,
  WorkspaceEvidenceObject,
  WorkspaceReviewFingerprint,
} from "../../runtime/workspace-prepare";
import type { HostState, WorkspaceRow } from "./host-state";
import type { RuntimeEventPublisher } from "./runtime-event-publisher";
import type { RuntimeObjectRegistry } from "./runtime-objects";

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import {
  WORKSPACE_REVIEW_MAX_BYTES,
  WORKSPACE_REVIEW_OBJECT_NAME,
} from "../../runtime/workspace-prepare";

import { SupervisorError } from "./types";
import { sealWorkspaceOutput } from "./workspace-output-object";
import { resolveOwnedCheckpoint } from "./workspace-git-checkpoint";
import { withPreparedGitIndex } from "./workspace-git-index";
import { readWorkspaceReviewSnapshot } from "./workspace-review-snapshot";
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

function oversizedDiff(): SupervisorError {
  return new SupervisorError(
    "PRECONDITION",
    "The workspace diff exceeds the 64 KiB review limit",
    {
      details: { reason: "workspace_diff_too_large" },
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

async function captureWorkspaceDiff(
  state: HostState,
  query: WorkspaceDiffQuery & Readonly<{ handle: string }>,
) {
  const { handle, generation } = query;
  const owned = loadPreparedWorkspace(state, handle, generation);
  if (!owned) return null;
  const { workspace } = owned;
  const fence = state.getFence(workspace.runId);
  if (!fence || workspace.kind !== "git_worktree") throw diffRefusal();

  const git = [
    "--no-optional-locks",
    "--no-replace-objects",
    "-C",
    workspace.realPath,
  ];
  let base: string;
  let bytes: Buffer;
  try {
    if ((await realpath(workspace.realPath)) !== workspace.realPath)
      throw diffRefusal();
    const observed = await observePreparedGitHead(workspace);
    const head = query.head ?? observed.commit;
    const checkpoint = query.checkpointId
      ? await resolveOwnedCheckpoint({
          state,
          git,
          handle,
          generation,
          checkpointId: query.checkpointId,
          owner: {
            runId: workspace.runId,
            assignmentId: fence.assignmentId,
            assignmentEpoch: fence.epoch,
          },
        })
      : null;
    base = checkpoint?.snapshot ?? query.base ?? head;
    for (const [ancestor, descendant] of [
      [head, observed.commit],
      [checkpoint ? head : base, head],
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
    if (query.format === "review") {
      bytes = Buffer.from(
        JSON.stringify(await readWorkspaceReviewSnapshot(workspace, git, base)),
      );
      if (bytes.byteLength > WORKSPACE_REVIEW_MAX_BYTES) throw oversizedDiff();
    } else {
      bytes = query.head
        ? await executeWorkspaceGitBytes(args)
        : await readWorkingTreePatch(workspace, git, args);
    }
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
      error instanceof SupervisorError &&
      error.details?.reason === "workspace_diff_too_large"
    )
      throw error;
    if (
      (error as NodeJS.ErrnoException).code ===
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    )
      throw oversizedDiff();
    throw diffRefusal();
  }

  return { bytes, base, workspace, fence };
}

/** Return the same digest as the sealed Review object without adding an object or event. */
export async function readWorkspaceReviewFingerprint(
  state: HostState,
  input: Readonly<{ handle: string; generation: number; base: string }>,
): Promise<WorkspaceReviewFingerprint | null> {
  const captured = await captureWorkspaceDiff(state, {
    ...input,
    format: "review",
  });
  if (!captured) return null;

  return {
    generation: input.generation,
    baseCommit: captured.base,
    sha256: createHash("sha256").update(captured.bytes).digest("hex"),
  };
}

/** Capture only commits reachable from the owned checkout and seal the bounded Git patch. */
export async function sealWorkspaceDiff(
  services: Readonly<{
    state: HostState;
    objects: RuntimeObjectRegistry;
    events: RuntimeEventPublisher;
  }>,
  query: WorkspaceDiffQuery & Readonly<{ handle: string }>,
): Promise<WorkspaceEvidenceObject | null> {
  const captured = await captureWorkspaceDiff(services.state, query);
  if (!captured) return null;
  const { bytes, base, workspace, fence } = captured;
  const { handle, generation } = query;
  const object = await sealWorkspaceOutput(
    services,
    {
      runId: workspace.runId,
      assignmentId: fence.assignmentId,
      assignmentEpoch: fence.epoch,
    },
    {
      logicalName:
        query.format === "review"
          ? WORKSPACE_REVIEW_OBJECT_NAME
          : "workspace-diff.patch",
      mimeType: query.format === "review" ? "application/json" : "text/x-diff",
      bytes,
      source: {
        workspaceGitDiff: {
          handle,
          generation,
          base,
          head: query.head ?? null,
          ...(query.format ? { format: query.format } : {}),
        },
      },
    },
  );

  return {
    generation,
    object,
    ...(query.checkpointId ? { baseCommit: base } : {}),
  };
}
