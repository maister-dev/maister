import type {
  WorkspaceCheckpointRequest,
  WorkspaceGitCheckpointResult,
  WorkspaceRestoreRequest,
} from "../../runtime/workspace-prepare";
import type { HostState, WorkspaceRow } from "./host-state";

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { GIT_OBJECT_ID } from "../../runtime/wait-head";
import { isWorkspaceGenerationTarget } from "../../runtime/workspace-prepare";

import { SupervisorError } from "./types";
import { withPreparedGitIndex } from "./workspace-git-index";
import {
  executeWorkspaceGit,
  executeWorkspaceGitBytes,
} from "./workspace-source";
import {
  loadPreparedWorkspace,
  observePreparedGitHead,
} from "./workspace-status";

type OwnedGitOperation = Readonly<{
  state: HostState;
  handle: string;
  assertOwner: () => void;
}>;

type OwnedGit = Readonly<{
  workspace: WorkspaceRow;
  git: readonly string[];
  replayingClaim: boolean;
}>;

export class WorkspaceGitEffectUnconfirmed extends Error {}

function checkpointRef(
  handle: string,
  generation: number,
  checkpointId: string,
): string {
  return `refs/maister/owned-checkpoints/${handle}/${generation}/${checkpointId}`;
}

function invalidCheckpoint(): SupervisorError {
  return new SupervisorError(
    "PRECONDITION",
    "No verified checkpoint belongs to this workspace generation",
    {
      details: { reason: "workspace_checkpoint_unknown" },
    },
  );
}

async function claimGitOperation(
  input: OwnedGitOperation,
  request: WorkspaceCheckpointRequest | WorkspaceRestoreRequest,
): Promise<OwnedGit> {
  const { handle, state, assertOwner } = input;
  const { generation } = request.payload;
  const prepared = loadPreparedWorkspace(state, handle, generation);
  if (
    !prepared ||
    prepared.mode !== "ownWorktree" ||
    prepared.workspace.runId !== request.owner.runId ||
    (await realpath(prepared.workspace.realPath)) !==
      prepared.workspace.realPath
  )
    throw new SupervisorError(
      "PRECONDITION",
      "Git checkpoint requires an owned worktree",
      {
        details: { reason: "workspace_rejected" },
      },
    );
  const { workspace } = prepared;
  await observePreparedGitHead(workspace);
  assertOwner();
  const replayingClaim =
    state.getWorkspaceExecutionState(handle)?.operationClaimId ===
    request.command.id;
  if (
    !state.claimWorkspaceGitOperation({
      ...request.owner,
      handle,
      generation,
      commandId: request.command.id,
      physicalKey: createHash("sha256")
        .update(workspace.realPath)
        .digest("hex"),
    })
  )
    throw new SupervisorError(
      "PRECONDITION",
      "A process or another Git operation still owns this workspace",
      {
        details: { reason: "workspace_writer_active" },
      },
    );

  return {
    workspace,
    git: ["--no-replace-objects", "-C", workspace.realPath],
    replayingClaim,
  };
}

async function captureOwnedTree(owned: OwnedGit): Promise<string> {
  return withPreparedGitIndex(owned.workspace, owned.git, async (indexFile) => {
    await executeWorkspaceGitBytes([...owned.git, "add", "-A", "--", "."], {
      indexFile,
    });
    const tree = (
      await executeWorkspaceGitBytes([...owned.git, "write-tree"], {
        indexFile,
      })
    )
      .toString("utf8")
      .trim();
    if (!GIT_OBJECT_ID.test(tree)) throw invalidCheckpoint();

    return tree;
  });
}

async function readCheckpointCommit(
  git: readonly string[],
  ref: string,
): Promise<string | null> {
  const resolved = await executeWorkspaceGit([
    ...git,
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
    ref,
  ]);
  if (resolved === "") return null;
  const [name, commit, extra] = resolved.split("\0");
  if (name !== ref || extra !== undefined || !GIT_OBJECT_ID.test(commit))
    throw invalidCheckpoint();

  return commit;
}

export async function checkpointOwnedWorkspace(
  input: OwnedGitOperation,
  request: WorkspaceCheckpointRequest,
): Promise<WorkspaceGitCheckpointResult> {
  const owned = await claimGitOperation(input, request);
  const { git, workspace } = owned;
  const { generation } = request.payload;
  const checkpointId = request.command.id;
  const ref = checkpointRef(input.handle, generation, checkpointId);
  const existing = await readCheckpointCommit(git, ref);
  if (existing) {
    if (!owned.replayingClaim) throw invalidCheckpoint();
    const tree = await executeWorkspaceGit([
      ...git,
      "rev-parse",
      "--verify",
      `${existing}^{tree}`,
    ]);
    if (!GIT_OBJECT_ID.test(tree)) throw invalidCheckpoint();

    return { generation, checkpointId, tree };
  }
  const head = await observePreparedGitHead(workspace);
  const tree = await captureOwnedTree(owned);
  const snapshot = await executeWorkspaceGit([
    ...git,
    "-c",
    "user.name=MAIster checkpoint",
    "-c",
    "user.email=checkpoint@maister.local",
    "-c",
    "commit.gpgSign=false",
    "commit-tree",
    tree,
    "-p",
    head.commit,
    "-m",
    `MAIster checkpoint ${checkpointId}`,
  ]);
  const verified = await observePreparedGitHead(workspace);
  if (
    !GIT_OBJECT_ID.test(snapshot) ||
    verified.commit !== head.commit ||
    verified.ref !== head.ref
  )
    throw invalidCheckpoint();
  input.assertOwner();
  await executeWorkspaceGit([
    ...git,
    "update-ref",
    "--no-deref",
    ref,
    snapshot,
    "0".repeat(snapshot.length),
  ]);

  return { generation, checkpointId, tree };
}

export async function restoreOwnedWorkspace(
  input: OwnedGitOperation,
  request: WorkspaceRestoreRequest,
): Promise<WorkspaceGitCheckpointResult | null> {
  const owned = await claimGitOperation(input, request);
  const { git, workspace } = owned;
  const { generation, checkpointId } = request.payload;
  const checkpoint = input.state.getReceipt(checkpointId);
  const evidence = checkpoint?.body as
    | {
        workspaceTarget?: unknown;
        result?: WorkspaceGitCheckpointResult;
      }
    | undefined;
  const target = evidence?.workspaceTarget;
  const expected = evidence?.result;
  if (
    checkpoint?.kind !== "workspace.checkpoint" ||
    checkpoint.phase !== "completed" ||
    checkpoint.runId !== request.owner.runId ||
    checkpoint.assignmentId !== request.owner.assignmentId ||
    checkpoint.epoch !== request.owner.assignmentEpoch ||
    !isWorkspaceGenerationTarget(target) ||
    target.handle !== input.handle ||
    target.generation !== generation ||
    !expected ||
    expected.checkpointId !== checkpointId ||
    expected.generation !== generation
  )
    throw invalidCheckpoint();
  const snapshot = await readCheckpointCommit(
    git,
    checkpointRef(input.handle, generation, checkpointId),
  );
  if (!snapshot) throw invalidCheckpoint();
  const [tree, base] = await Promise.all([
    executeWorkspaceGit([
      ...git,
      "rev-parse",
      "--verify",
      `${snapshot}^{tree}`,
    ]),
    executeWorkspaceGit([...git, "rev-parse", "--verify", `${snapshot}^`]),
  ]);
  if (
    tree !== expected.tree ||
    !GIT_OBJECT_ID.test(tree) ||
    !GIT_OBJECT_ID.test(base)
  )
    throw invalidCheckpoint();
  const restored = async (): Promise<boolean> =>
    (await observePreparedGitHead(workspace)).commit === base &&
    (await executeWorkspaceGit([
      ...git,
      "diff",
      "--cached",
      "--name-only",
      "--",
    ])) === "" &&
    (await captureOwnedTree(owned)) === tree;
  input.assertOwner();
  if (owned.replayingClaim) return (await restored()) ? expected : null;

  try {
    await executeWorkspaceGit([...git, "clean", "-fd", "--"]);
    input.assertOwner();
    await executeWorkspaceGit([...git, "reset", "--hard", base]);
    input.assertOwner();
    await executeWorkspaceGit([...git, "read-tree", "--reset", "-u", tree]);
    input.assertOwner();
    await executeWorkspaceGit([...git, "reset", "--mixed", base]);
    input.assertOwner();
    if (await restored()) return expected;
  } catch (cause) {
    throw new WorkspaceGitEffectUnconfirmed(
      "Git restore must be reconciled against its retained checkpoint",
      { cause },
    );
  }
  throw new WorkspaceGitEffectUnconfirmed(
    "Git restore could not verify the resulting workspace",
  );
}
