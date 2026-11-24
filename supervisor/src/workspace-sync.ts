import type { HostState } from "./host-state";
import type {
  WorkspaceSyncRequest,
  WorkspaceSyncResult,
} from "../../runtime/workspace-prepare";

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { SupervisorError } from "./types";
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

function syncConflict(
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

async function commitAt(
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

async function makeSyncCandidate(
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
      const conflicts = await executeWorkspaceGit([
        ...isolated,
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);
      if (conflicts)
        throw syncConflict(
          "sync_conflict",
          "The reviewed target conflicts with the retained workspace",
        );
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
    payload: { generation, expected, strategy },
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
  const result = async (head: string): Promise<WorkspaceSyncResult> => {
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

    return {
      generation,
      head,
      priorTarget: target,
      observedTarget: target,
      behind,
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

  return result(candidate);
}
