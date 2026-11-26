import type { HostState } from "./host-state";
import type {
  WorkspaceSyncRequest,
  WorkspaceSyncResult,
} from "../../runtime/workspace-prepare";

import { createHash } from "node:crypto";

import { commitAt, makeSyncCandidate, syncConflict } from "./workspace-git-candidate";
import { WorkspaceGitEffectUnconfirmed } from "./workspace-git-checkpoint";
import { ownedWorkspaceSourceGit } from "./workspace-publish";
import {
  executeWorkspaceGit,
  observeWorkspaceTarget,
} from "./workspace-source";
import { inspectWorkspace } from "./workspace-status";

type SyncInput = Readonly<{
  state: HostState;
  runtimeRoot: string;
  source: string;
  runId: string;
  assignmentId: string;
  assignmentEpoch: number;
  assertOwner: () => void;
}>;

type SyncPublication = NonNullable<WorkspaceSyncRequest["payload"]["publish"]>;

async function verifySyncPublicationLease(input: {
  git: readonly string[];
  source: string;
  publish: SyncPublication;
  head: string;
  privateRef: string;
}): Promise<void> {
  const { git, source, publish, head, privateRef } = input;
  const { targetRef, priorTarget } = publish;
  if (await observeWorkspaceTarget(source, targetRef, git) !== priorTarget)
    throw syncConflict("target_ref_changed", "The published branch advanced before sync");
  if (!priorTarget) return;

  await executeWorkspaceGit([
    ...git, "fetch", "--no-tags", "--no-write-fetch-head", "--",
    source, `+${targetRef}:${privateRef}`,
  ]);
  if (await commitAt(git, privateRef) !== priorTarget)
    throw syncConflict("target_ref_changed", "The published branch advanced during fetch");
  try {
    await executeWorkspaceGit([...git, "merge-base", "--is-ancestor", priorTarget, head]);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
    throw syncConflict("target_ref_changed", "Sync cannot overwrite unpublished remote commits");
  }
}

async function confirmSyncPublication(input: {
  git: readonly string[];
  source: string;
  publish: SyncPublication;
  candidate: string;
  push: (() => Promise<string>) | null;
}): Promise<NonNullable<WorkspaceSyncResult["publication"]>> {
  const { git, source, publish, candidate, push } = input;
  let failure: unknown;
  try {
    await push?.();
  } catch (error) {
    failure = error;
  }
  try {
    if (await observeWorkspaceTarget(source, publish.targetRef, git) === candidate)
      return { ...publish, observedTarget: candidate };
  } catch (error) {
    failure = failure ? new AggregateError([failure, error]) : error;
  }
  throw new WorkspaceGitEffectUnconfirmed(
    "The supervisor could not verify the retained sync publication",
    { cause: failure },
  );
}

/** Compute a recoverable Git candidate before changing the live owned worktree. */
export async function syncOwnedWorkspace(
  input: SyncInput,
  request: WorkspaceSyncRequest,
): Promise<WorkspaceSyncResult> {
  const { state, source, assertOwner, runId, assignmentId, assignmentEpoch } =
    input;
  const {
    owner,
    command,
    payload: { generation, expected, strategy, publish },
  } = request;
  const handle = owner.workspaceHandle;
  const target = expected.priorTarget;
  if (!target)
    throw syncConflict(
      "target_ref_changed",
      "Sync needs an exact approved target",
    );
  const { workspace, git } = await ownedWorkspaceSourceGit({
    ...input,
    handle,
    generation,
    remoteId: expected.remoteId,
    targetRef: expected.targetRef,
  });
  const replaying =
    state.getWorkspaceExecutionState(handle)?.operationClaimId === command.id;
  const candidateRef = `refs/maister/retained-sync/${handle}/${generation}/${command.id}`;
  const recorded = replaying ? await commitAt(git, candidateRef) : null;
  const checkout = await inspectWorkspace(state, handle, generation);
  const observedHead = checkout?.workspace.observedCommit;
  const clean = checkout?.workingTree === "clean";
  const result = async (head: string, push?: () => Promise<string>): Promise<WorkspaceSyncResult> => {
    const count = await executeWorkspaceGit([
      ...git,
      "rev-list",
      "--count",
      `${expected.head}..${target}`,
    ]);
    const behind = Number(count);
    if (!/^\d+$/u.test(count) || !Number.isSafeInteger(behind))
      throw new WorkspaceGitEffectUnconfirmed(
        "The supervisor could not verify the sync distance",
      );

    const publication = publish && behind > 0
      ? await confirmSyncPublication({ git, source, publish, candidate: head, push: push ?? null })
      : undefined;
    return {
      generation,
      head,
      priorTarget: target,
      observedTarget: target,
      behind,
      ...(publication ? { publication } : {}),
    };
  };
  if (recorded && observedHead === recorded && clean) return result(recorded);
  if (!clean || observedHead !== expected.head || workspace.runId !== runId) {
    if (replaying)
      throw new WorkspaceGitEffectUnconfirmed(
        "The accepted sync no longer has a provable checkout",
      );
    throw syncConflict(
      "head_changed",
      "Sync requires the unchanged clean workspace",
    );
  }

  let candidate = recorded;
  if (!candidate) {
    if (
      (await observeWorkspaceTarget(source, expected.targetRef, git)) !== target
    )
      throw syncConflict(
        "target_ref_changed",
        "The approved sync target advanced before fetch",
      );
    const targetRef = candidateRef + "-target";
    await executeWorkspaceGit([
      ...git,
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--",
      source,
      `+${expected.targetRef}:${targetRef}`,
    ]);
    if ((await commitAt(git, targetRef)) !== target)
      throw syncConflict(
        "target_ref_changed",
        "The approved sync target advanced during fetch",
      );
    candidate = await makeSyncCandidate(
      input.runtimeRoot,
      git,
      expected.head,
      target,
      strategy,
    );
    if (publish && candidate !== expected.head)
      await verifySyncPublicationLease({
        git, source, publish, head: expected.head, privateRef: candidateRef + "-publication",
      });
  }

  assertOwner();
  if (
    !replaying &&
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
    throw syncConflict(
      "workspace_writer_active",
      "The selected checkout has a different writer",
    );
  if (!recorded)
    await executeWorkspaceGit([
      ...git,
      "update-ref",
      candidateRef,
      candidate,
      "0".repeat(expected.head.length),
    ]);
  const current = await inspectWorkspace(state, handle, generation);
  if (
    current?.workspace.observedCommit !== expected.head ||
    current.workingTree !== "clean"
  )
    throw new WorkspaceGitEffectUnconfirmed(
      "The retained checkout changed before sync application",
    );
  const firstPublication = publish && !recorded && candidate !== expected.head ? publish : null;
  if (firstPublication && (await observeWorkspaceTarget(source, expected.targetRef, git)) !== target)
    throw syncConflict("target_ref_changed", "The exact sync target changed before publication");
  assertOwner();
  const confirmed = await result(candidate, firstPublication
    ? () => executeWorkspaceGit([
        ...git, "push", "--no-follow-tags", "--recurse-submodules=no",
        `--force-with-lease=${firstPublication.targetRef}:${firstPublication.priorTarget ?? ""}`,
        "--", source, `${candidate}:${firstPublication.targetRef}`,
      ])
    : undefined);
  if (candidate !== expected.head) {
    assertOwner();
    await executeWorkspaceGit([...git, "reset", "--keep", candidate]);
    const after = await inspectWorkspace(state, handle, generation);
    if (
      after?.workspace.observedCommit !== candidate ||
      after.workingTree !== "clean"
    )
      throw new WorkspaceGitEffectUnconfirmed(
        "The exact synced checkout could not be verified",
      );
  }

  return confirmed;
}
