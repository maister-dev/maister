import type {
  WorkspacePublishRequest,
  WorkspacePublishResult,
  WorkspacePublicationTarget,
} from "../../runtime/workspace-prepare";
import type { HostState, WorkspaceRow } from "./host-state";

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { workspaceEvidenceDigest } from "../../runtime/workspace-prepare";

import { SupervisorError } from "./types";
import { commitAt, makeSyncCandidate } from "./workspace-git-candidate";
import { WorkspaceGitEffectUnconfirmed } from "./workspace-git-checkpoint";
import {
  executeWorkspaceGit,
  observeWorkspaceTarget,
} from "./workspace-source";
import {
  inspectWorkspace,
  loadPreparedWorkspace,
  observePreparedGitHead,
} from "./workspace-status";

type PublishInput = Readonly<{
  state: HostState;
  runtimeRoot: string;
  source: string;
  assignmentId: string;
  assignmentEpoch: number;
  runId: string;
}>;
type PublicationTargetInput = Pick<
  PublishInput,
  "state" | "runtimeRoot" | "source"
> &
  Omit<WorkspacePublicationTarget, "priorTarget"> &
  Readonly<{ handle: string }>;

function publicationRefused(
  reason:
    | "workspace_rejected"
    | "source_ref_unapproved"
    | "target_ref_changed"
    | "head_changed"
    | "workspace_writer_active",
  message: string,
): SupervisorError {
  return new SupervisorError(
    reason === "target_ref_changed" || reason === "head_changed"
      ? "CONFLICT"
      : "PRECONDITION",
    message,
    { details: { reason } },
  );
}

function observedPublication(
  request: WorkspacePublishRequest,
  observedTarget: string,
): WorkspacePublishResult {
  const { publication, generation, expected } = request.payload;

  return {
    publication,
    git: {
      generation,
      head: expected.head,
      priorTarget: expected.priorTarget,
      observedTarget,
    },
  };
}

export async function ownedWorkspaceSourceGit(
  input: PublicationTargetInput,
): Promise<{ workspace: WorkspaceRow; git: readonly string[] }> {
  const { state, source, handle, generation, remoteId } = input;
  const prepared = loadPreparedWorkspace(state, handle, generation);
  if (
    !prepared ||
    prepared.mode !== "ownWorktree" ||
    prepared.workspace.projectSlug !== remoteId
  )
    throw publicationRefused(
      "workspace_rejected",
      "Publication requires the retained owned Git checkout",
    );

  const { workspace } = prepared;
  const cache = join(
    await realpath(input.runtimeRoot),
    ".maister",
    "managed-workspaces",
    "repositories",
    workspaceEvidenceDigest(source),
  );
  if (workspace.repoPath !== cache || (await realpath(cache)) !== cache)
    throw publicationRefused(
      "source_ref_unapproved",
      "The retained checkout's approved Git source has changed",
    );
  await observePreparedGitHead(workspace);
  const git = ["--no-replace-objects", "-C", workspace.realPath];
  const approvedPush = await executeWorkspaceGit([
    ...git,
    "remote",
    "get-url",
    "--push",
    "--all",
    "origin",
  ]);
  const approvedRead = await executeWorkspaceGit([
    ...git,
    "remote",
    "get-url",
    "--all",
    "origin",
  ]);
  if (approvedPush !== source || approvedRead !== source)
    throw publicationRefused(
      "source_ref_unapproved",
      "The Git remote no longer matches host configuration",
    );

  return { workspace, git };
}

export async function readOwnedPublicationTarget(
  input: PublicationTargetInput,
): Promise<WorkspacePublicationTarget> {
  const { generation, remoteId, source, targetRef } = input;
  const { git } = await ownedWorkspaceSourceGit(input);

  return {
    generation,
    remoteId,
    targetRef,
    priorTarget: await observeWorkspaceTarget(source, targetRef, git),
  };
}

/** Bind one fast-forward publication to a private checkout and a retained mutation fence. */
export async function publishOwnedWorkspace(
  input: PublishInput,
  request: WorkspacePublishRequest,
): Promise<WorkspacePublishResult> {
  const { state, source, runId, assignmentId, assignmentEpoch } = input;
  const {
    owner,
    command,
    payload: { generation, expected, integration },
  } = request;
  const handle = owner.workspaceHandle;
  const current = state.getWorkspaceExecutionState(handle);
  const replaying = current?.operationClaimId === command.id;
  if (!replaying && current && current.publicationFence >= owner.fence)
    throw new SupervisorError(
      "FENCED",
      "The retained workspace already has a newer publication fence",
      {
        details: { reason: "stale_workspace_claim" },
      },
    );
  const { workspace, git } = await ownedWorkspaceSourceGit({
    ...input,
    handle,
    generation,
    remoteId: expected.remoteId,
    targetRef: expected.targetRef,
  });
  if (workspace.runId !== runId || owner.workspaceGeneration !== generation)
    throw publicationRefused(
      "workspace_rejected",
      "Publication requires the retained owned Git checkout",
    );

  const observed = await observeWorkspaceTarget(
    source,
    expected.targetRef,
    git,
  );
  const candidateRef = `refs/maister/retained-publish/${handle}/${generation}/${command.id}`;
  if (replaying) {
    const candidate = integration ? await commitAt(git, candidateRef) : expected.head;
    if (candidate && observed === candidate)
      return observedPublication(request, observed);
    throw new WorkspaceGitEffectUnconfirmed(
      "The retained publication could not prove its resulting remote ref",
    );
  }
  if (observed !== expected.priorTarget)
    throw publicationRefused(
      "target_ref_changed",
      "The approved target changed before publication",
    );
  const checkout = await inspectWorkspace(state, handle, generation);
  if (checkout?.workspace.observedCommit !== expected.head)
    throw publicationRefused(
      "head_changed",
      "The retained checkout is no longer at its approved HEAD",
    );
  if (checkout.workingTree !== "clean")
    throw publicationRefused(
      "workspace_rejected",
      "The retained checkout contains unpublished changes",
    );
  let candidate = expected.head;
  if (integration) {
    const target = expected.priorTarget;
    if (!target)
      throw publicationRefused("target_ref_changed", "Integration requires an existing exact target");
    const targetRef = candidateRef + "-target";
    await executeWorkspaceGit([
      ...git, "fetch", "--no-tags", "--no-write-fetch-head", "--",
      source, `+${expected.targetRef}:${targetRef}`,
    ]);
    if (await commitAt(git, targetRef) !== target)
      throw publicationRefused("target_ref_changed", "The reviewed target advanced before integration");
    candidate = await commitAt(git, candidateRef) ?? await makeSyncCandidate(
      input.runtimeRoot, git,
      integration === "merge" ? target : expected.head,
      integration === "merge" ? expected.head : target,
      integration,
    );
    await executeWorkspaceGit([...git, "update-ref", candidateRef, candidate]);
  }
  if (expected.priorTarget !== null) {
    try {
      await executeWorkspaceGit([
        ...git,
        "merge-base",
        "--is-ancestor",
        expected.priorTarget,
        candidate,
      ]);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
      throw publicationRefused(
        "target_ref_changed",
        "Publication would overwrite unrelated Git history",
      );
    }
  }
  if (
    !state.claimWorkspaceGitOperation({
      commandId: command.id,
      runId,
      assignmentId,
      assignmentEpoch,
      handle,
      generation,
      physicalKey: createHash("sha256")
        .update(workspace.realPath)
        .digest("hex"),
      retainedFence: owner.fence,
    })
  )
    throw publicationRefused(
      "workspace_writer_active",
      "The checkout has a newer operation fence or a live writer",
    );

  if (candidate === expected.priorTarget)
    return observedPublication(request, candidate);

  // The claim remains durable until the terminal outcome and event commit together.
  try {
    await executeWorkspaceGit([
      ...git,
      "push",
      "--no-follow-tags",
      "--recurse-submodules=no",
      `--force-with-lease=${expected.targetRef}:${expected.priorTarget ?? ""}`,
      "--",
      source,
      `${candidate}:${expected.targetRef}`,
    ]);
  } catch (cause) {
    // The connection can end after Git advances the remote ref.
    try {
      const confirmed = await observeWorkspaceTarget(
        source,
        expected.targetRef,
        git,
      );
      if (confirmed === candidate)
        return observedPublication(request, confirmed);
    } catch (readError) {
      throw new WorkspaceGitEffectUnconfirmed(
        "Git push and target verification both failed",
        {
          cause: new AggregateError([cause, readError]),
        },
      );
    }
    throw new WorkspaceGitEffectUnconfirmed(
      "Git push outcome could not be reconciled",
      { cause },
    );
  }
  const confirmed = await observeWorkspaceTarget(
    source,
    expected.targetRef,
    git,
  ).catch((cause: unknown) => {
    throw new WorkspaceGitEffectUnconfirmed(
      "Git target verification failed after the push",
      { cause },
    );
  });
  if (confirmed !== candidate)
    throw new WorkspaceGitEffectUnconfirmed(
      "Git target does not confirm the accepted publication",
    );

  return observedPublication(request, confirmed);
}
