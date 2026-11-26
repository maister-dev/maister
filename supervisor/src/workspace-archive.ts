import type {
  WorkspacePreserveRequest,
  WorkspacePreserveResult,
  WorkspaceReleaseRequest,
  WorkspaceReleaseResult,
} from "../../runtime/workspace-prepare";
import type { HostState, WorkspaceRow } from "./host-state";

import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { GIT_OBJECT_ID } from "../../runtime/wait-head";
import {
  isWorkspaceOperationOwner,
  workspaceEvidenceDigest,
} from "../../runtime/workspace-prepare";

import { SupervisorError } from "./types";
import {
  captureOwnedTree,
  WorkspaceGitEffectUnconfirmed,
} from "./workspace-git-checkpoint";
import { executeWorkspaceGit } from "./workspace-source";
import { observePreparedGitHead } from "./workspace-status";

type ArchiveService = Readonly<{
  state: HostState;
  runtimeRoot: string;
  assertOwner: () => void;
}>;

function noPreservation(): SupervisorError {
  return new SupervisorError(
    "PRECONDITION",
    "An exact retained archive is required before removing the checkout",
    {
      details: { reason: "retained_disposition_required" },
    },
  );
}

function archiveRef(
  handle: string,
  generation: number,
  dispositionId: string,
): string {
  return `refs/maister/retained-archives/${handle}/${generation}/${dispositionId}`;
}

async function archiveWorkspace(
  input: ArchiveService,
  owner: WorkspacePreserveRequest["owner"],
): Promise<WorkspaceRow & { repoPath: string }> {
  const workspace = input.state.getWorkspace(owner.workspaceHandle);
  const execution = input.state.getWorkspaceExecutionState(
    owner.workspaceHandle,
  );
  const managedRoot = join(
    await realpath(input.runtimeRoot),
    ".maister",
    "managed-workspaces",
  );
  if (
    !workspace ||
    workspace.releasedAt !== null ||
    !workspace.repoPath ||
    dirname(workspace.realPath) !== join(managedRoot, "runs") ||
    dirname(workspace.repoPath) !== join(managedRoot, "repositories") ||
    (await realpath(workspace.repoPath)) !== workspace.repoPath ||
    execution?.generation !== owner.workspaceGeneration ||
    execution.preparationMode !== "ownWorktree"
  )
    throw noPreservation();

  return { ...workspace, repoPath: workspace.repoPath };
}

export async function preserveOwnedWorkspace(
  input: ArchiveService,
  request: WorkspacePreserveRequest,
): Promise<WorkspacePreserveResult> {
  const { command, owner } = request;
  const { generation } = request.payload;
  const workspace = await archiveWorkspace(input, owner);
  const oldAssignment = input.state.getFence(workspace.runId);
  input.assertOwner();
  if (
    !oldAssignment ||
    !input.state.claimWorkspaceGitOperation({
      commandId: command.id,
      runId: workspace.runId,
      assignmentId: oldAssignment.assignmentId,
      assignmentEpoch: oldAssignment.epoch,
      handle: owner.workspaceHandle,
      generation,
      physicalKey: createHash("sha256")
        .update(workspace.realPath)
        .digest("hex"),
      retainedFence: owner.fence,
      requireExclusiveHandle: true,
    })
  )
    throw new SupervisorError(
      "CONFLICT",
      "A retained owner or live process still holds the worktree",
      {
        details: { reason: "workspace_writer_active" },
      },
    );
  const git = ["--no-replace-objects", "-C", workspace.realPath];
  const ref = archiveRef(owner.workspaceHandle, generation, command.id);
  try {
    if ((await realpath(workspace.realPath)) !== workspace.realPath)
      throw noPreservation();
    const head = await observePreparedGitHead(workspace);
    const tree = await captureOwnedTree({ workspace, git });
    const retained = await executeWorkspaceGit([
      ...git,
      "for-each-ref",
      "--format=%(objectname)",
      ref,
    ]);
    if (retained) {
      const identity = await executeWorkspaceGit([
        ...git,
        "rev-parse",
        "--verify",
        retained + "^{commit}",
      ]);
      if (
        !GIT_OBJECT_ID.test(identity) ||
        (await executeWorkspaceGit([
          ...git,
          "rev-parse",
          identity + "^1",
          identity + "^{tree}",
        ])) !== `${head.commit}\n${tree}`
      )
        throw noPreservation();

      return {
        generation,
        dispositionId: command.id,
        retainedCommit: identity,
      };
    }
    const retainedCommit = await executeWorkspaceGit([
      ...git,
      "-c",
      "user.name=MAIster archive",
      "-c",
      "user.email=archive@maister.local",
      "-c",
      "commit.gpgSign=false",
      "commit-tree",
      tree,
      "-p",
      head.commit,
      "-m",
      "MAIster retained workspace archive",
    ]);
    if (
      !GIT_OBJECT_ID.test(retainedCommit) ||
      (await observePreparedGitHead(workspace)).commit !== head.commit
    )
      throw noPreservation();
    input.assertOwner();
    await executeWorkspaceGit([
      ...git,
      "update-ref",
      "--no-deref",
      ref,
      retainedCommit,
      "0".repeat(retainedCommit.length),
    ]);

    return { generation, dispositionId: command.id, retainedCommit };
  } catch (cause) {
    throw new WorkspaceGitEffectUnconfirmed(
      "The retained workspace archive could not be verified",
      { cause },
    );
  }
}

export async function releaseArchivedWorkspace(
  input: ArchiveService,
  request: WorkspaceReleaseRequest,
): Promise<WorkspaceReleaseResult> {
  const {
    owner,
    payload: { generation, dispositionId, quiescenceId },
  } = request;
  const handle = owner.workspaceHandle;
  const workspace = await archiveWorkspace(input, owner);
  const execution = input.state.getWorkspaceExecutionState(handle);
  const receipt = input.state.getReceipt(dispositionId);
  const evidence = receipt?.body as
    | {
        workspaceOwner?: unknown;
        archiveQuiescenceId?: unknown;
        result?: WorkspacePreserveResult;
      }
    | undefined;
  const archive = evidence?.result;
  if (
    !archive ||
    receipt?.kind !== "workspace.preserve" ||
    receipt.phase !== "completed" ||
    receipt.runId !== workspace.runId ||
    archive.generation !== generation ||
    archive.dispositionId !== dispositionId ||
    evidence?.archiveQuiescenceId !== quiescenceId ||
    !isWorkspaceOperationOwner(evidence?.workspaceOwner) ||
    workspaceEvidenceDigest(evidence.workspaceOwner) !==
      workspaceEvidenceDigest(owner) ||
    execution?.operationClaimId !== dispositionId ||
    execution.publicationFence !== owner.fence
  )
    throw noPreservation();
  const git = ["--no-replace-objects", "-C", workspace.repoPath];
  const ref = archiveRef(handle, generation, dispositionId);
  const retained = await executeWorkspaceGit([
    ...git,
    "rev-parse",
    "--verify",
    ref + "^{commit}",
  ]);
  if (retained !== archive.retainedCommit || !GIT_OBJECT_ID.test(retained))
    throw noPreservation();
  let present: boolean;
  try {
    await lstat(workspace.realPath);
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    present = false;
  }
  input.assertOwner();
  if (present) {
    if ((await realpath(workspace.realPath)) !== workspace.realPath)
      throw noPreservation();
    const checkoutGit = ["--no-replace-objects", "-C", workspace.realPath];
    const head = await observePreparedGitHead(workspace);
    const tree = await captureOwnedTree({ workspace, git: checkoutGit });
    if (
      (await executeWorkspaceGit([
        ...git,
        "rev-parse",
        retained + "^1",
        retained + "^{tree}",
      ])) !== `${head.commit}\n${tree}`
    )
      throw noPreservation();
    input.assertOwner();
    try {
      await executeWorkspaceGit([
        ...git,
        "worktree",
        "remove",
        "--force",
        "--",
        workspace.realPath,
      ]);
    } catch (cause) {
      throw new WorkspaceGitEffectUnconfirmed(
        "The host could not confirm worktree removal",
        { cause },
      );
    }
  }

  return { handle, generation, dispositionId };
}
