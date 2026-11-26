import type { HostState } from "./host-state";
import type {
  WorkspaceSyncRequest,
  WorkspaceSyncResult,
} from "../../runtime/workspace-prepare";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { isWorkspaceOperationOwner, isWorkspaceSourceRef, workspaceEvidenceDigest } from "../../runtime/workspace-prepare";
import {
  commitAt, makeSyncCandidate, readWorkspaceConflictPaths, syncConflict, WorkspaceCandidateConflict,
} from "./workspace-git-candidate";
import { WorkspaceGitEffectUnconfirmed } from "./workspace-git-checkpoint";
import { ownedWorkspaceSourceGit } from "./workspace-publish";
import {
  executeWorkspaceGit,
  observeWorkspaceTarget,
} from "./workspace-source";
import { inspectWorkspace, observePreparedGitHead } from "./workspace-status";

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
type ResolverPreparation = NonNullable<WorkspaceSyncResult["resolverPrepared"]>;
type ConflictShape = Readonly<{
  git: readonly string[];
  strategy: WorkspaceSyncRequest["payload"]["strategy"];
  before: string;
  target: string;
}>;

async function readRebaseCommit(git: readonly string[], name: "onto" | "orig-head"): Promise<string | null> {
  const path = await executeWorkspaceGit([...git, "rev-parse", "--path-format=absolute", "--git-path", "rebase-merge/" + name]);
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function matchesPreparedOperation({ git, strategy, before, target }: ConflictShape): Promise<boolean> {
  const [currentSource, currentTarget] = strategy === "merge"
    ? await Promise.all([commitAt(git, "HEAD"), commitAt(git, "MERGE_HEAD")])
    : await Promise.all([readRebaseCommit(git, "orig-head"), readRebaseCommit(git, "onto")]);
  return currentSource === before && currentTarget === target;
}

async function readPreparedConflict(input: ConflictShape): Promise<readonly string[]> {
  return await matchesPreparedOperation(input) ? readWorkspaceConflictPaths(input.git) : [];
}

async function applyResolverConflict(input: ConflictShape): Promise<readonly string[]> {
  const { git, strategy, target } = input;
  try {
    await executeWorkspaceGit([
      ...git, "-c", "user.name=MAIster", "-c", "user.email=supervisor@maister.local", "-c", "commit.gpgsign=false",
      ...(strategy === "merge" ? ["merge", "--no-edit", "--no-ff"] : ["rebase", "--merge"]),
      target,
    ]);
  } catch (error) {
    const paths = await readPreparedConflict(input);
    if (paths.length) return paths;
    throw new WorkspaceGitEffectUnconfirmed("Could not verify the retained conflict", { cause: error });
  }
  throw new WorkspaceGitEffectUnconfirmed("The live checkout did not reproduce the frozen conflict");
}

function requireResolverPreparation(input: SyncInput, request: WorkspaceSyncRequest): ResolverPreparation {
  const { resolver, expected, publish, strategy, generation } = request.payload;
  const row = resolver && input.state.getReceipt(resolver.commandId);
  const body = row ? row.body as {
    workspaceOwner?: unknown;
    result?: WorkspaceSyncResult;
  } : null;
  const original = body?.workspaceOwner;
  const result = body?.result;
  const preparation = result?.resolverPrepared;
  if (!row || row.runId !== input.runId || row.kind !== "workspace.sync" ||
    row.phase !== "completed" || !isWorkspaceOperationOwner(original) ||
    original.hostKey !== request.owner.hostKey || original.workspaceHandle !== request.owner.workspaceHandle ||
    original.workspaceGeneration !== generation || original.claimId !== request.owner.claimId ||
    original.fence >= request.owner.fence || !preparation ||
    result?.head !== expected.head || result.observedTarget !== expected.priorTarget ||
    preparation.strategy !== strategy || preparation.targetRef !== expected.targetRef ||
    workspaceEvidenceDigest(preparation.publish ?? null) !== workspaceEvidenceDigest(publish ?? null))
    throw syncConflict("head_changed", "Resolver settlement does not match the prepared conflict");
  return preparation;
}

async function verifyResolvedBranch(input: ConflictShape, head: string): Promise<void> {
  const { git, target } = input;
  if (await commitAt(git, "MERGE_HEAD") || await readRebaseCommit(git, "onto"))
    throw syncConflict("sync_conflict", "Git conflict resolution is still in progress");
  try {
    await executeWorkspaceGit([...git, "merge-base", "--is-ancestor", target, head]);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1)
      throw syncConflict("sync_conflict", "The resolution does not contain the pinned target");
    throw error;
  }
  try {
    await executeWorkspaceGit([...git, "diff", "--check", target, head, "--"]);
  } catch (error) {
    const diagnostics = error as { code?: unknown; stdout?: string; stderr?: string };
    if (/leftover conflict marker/iu.test(diagnostics.stdout ?? ""))
      throw syncConflict("sync_conflict", "The resolution contains conflict markers");
    // Git exits 2 for whitespace diagnostics. Existing sync policy permits them.
    if (diagnostics.code !== 2 || diagnostics.stderr || !diagnostics.stdout) throw error;
  }
  if (await executeWorkspaceGit([...git, "rev-parse", target + "^{tree}"]) ===
    await executeWorkspaceGit([...git, "rev-parse", head + "^{tree}"]))
    throw syncConflict("sync_conflict", "The resolution dropped the original Run changes");
}

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
    payload: { generation, expected, strategy, publish, onConflict, resolver },
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
  const resolverRef = candidateRef + "-resolver-before";
  const recorded = replaying ? await commitAt(git, candidateRef) : null;
  const checkout = await inspectWorkspace(state, handle, generation);
  const observedHead = checkout?.workspace.observedCommit;
  const clean = checkout?.workingTree === "clean";
  const behindCount = async (): Promise<number> => {
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
    return behind;
  };
  const result = async (head: string, push?: () => Promise<string>): Promise<WorkspaceSyncResult> => {
    const behind = await behindCount();

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
  const conflictShape: ConflictShape = { git, strategy, before: expected.head, target };
  const conflictResult = async (conflictedFiles: readonly string[]): Promise<WorkspaceSyncResult> =>
    ({ generation, head: expected.head, priorTarget: target, observedTarget: target,
      behind: await behindCount(), conflictedFiles });
  const preparedResult = async (conflictedFiles: readonly string[]): Promise<WorkspaceSyncResult> => {
    const branch = await commitAt(git, resolverRef + "-detached") === expected.head
      ? "HEAD"
      : await executeWorkspaceGit([...git, "symbolic-ref", resolverRef + "-branch"]);
    if ((branch !== "HEAD" && !isWorkspaceSourceRef(branch)) || strategy === "fastForward")
      throw new WorkspaceGitEffectUnconfirmed("The resolver's original branch could not be verified");
    return {
      ...await conflictResult(conflictedFiles),
      resolverPrepared: { branch, strategy, targetRef: expected.targetRef, ...(publish ? { publish } : {}) },
    };
  };
  const preparedBefore = replaying && onConflict === "prepareResolver" ? await commitAt(git, resolverRef) : null;
  if (preparedBefore) {
    if (preparedBefore !== expected.head || await commitAt(git, candidateRef + "-target") !== target)
      throw new WorkspaceGitEffectUnconfirmed("The resolver checkpoint no longer matches its original request");
    const conflictedFiles = await readPreparedConflict(conflictShape);
    if (conflictedFiles.length) return preparedResult(conflictedFiles);
  }
  const claimMutation = (): void => {
    assertOwner();
    if (!replaying && !state.claimWorkspaceGitOperation({
      commandId: command.id, runId, assignmentId, assignmentEpoch, handle, generation,
      physicalKey: createHash("sha256").update(workspace.realPath).digest("hex"),
      retainedFence: owner.fence,
    }))
      throw syncConflict("workspace_writer_active", "The selected checkout has a different writer");
  };
  if (resolver) {
    const preparation = requireResolverPreparation(input, request);
    const before = `refs/maister/retained-sync/${handle}/${generation}/${resolver.commandId}-resolver-before`;
    if (await commitAt(git, before) !== expected.head)
      throw syncConflict("head_changed", "Resolver's original checkpoint is missing");
    const current = await observePreparedGitHead(workspace);
    if (resolver.action === "abort") {
      const prepared = await matchesPreparedOperation(conflictShape);
      if (!prepared && (!clean || current.ref !== preparation.branch))
        throw new WorkspaceGitEffectUnconfirmed("Unproved resolver edits remain in the checkout");
      claimMutation();
      if (prepared)
        await executeWorkspaceGit([...git, strategy === "merge" ? "merge" : "rebase", "--abort"]);
      else if (current.commit !== expected.head)
        await executeWorkspaceGit([...git, "reset", "--keep", expected.head]);
      const restored = await inspectWorkspace(state, handle, generation);
      if (restored?.workspace.observedCommit !== expected.head || restored.workingTree !== "clean")
        throw new WorkspaceGitEffectUnconfirmed("Could not verify the restored resolver checkout");
      return { generation, head: expected.head, priorTarget: target, observedTarget: target,
        behind: await behindCount(), resolverSettlement: "aborted" };
    }
    if (!clean || current.ref !== preparation.branch || (recorded && current.commit !== recorded))
      throw syncConflict("head_changed", "The resolver did not leave the approved branch clean");
    const head = current.commit;
    await verifyResolvedBranch(conflictShape, head);
    if (!recorded && await observeWorkspaceTarget(source, expected.targetRef, git) !== target)
      throw syncConflict("target_ref_changed", "The exact sync target moved during resolution");
    if (!recorded && publish)
      await verifySyncPublicationLease({ git, source, publish, head: expected.head, privateRef: candidateRef + "-publication" });
    claimMutation();
    if (!recorded)
      await executeWorkspaceGit([...git, "update-ref", candidateRef, head, "0".repeat(head.length)]);
    const firstPublication = publish && !recorded ? publish : null;
    const verified = await result(head, firstPublication
      ? () => executeWorkspaceGit([...git, "push", "--no-follow-tags", "--recurse-submodules=no",
          `--force-with-lease=${firstPublication.targetRef}:${firstPublication.priorTarget ?? ""}`,
          "--", source, `${head}:${firstPublication.targetRef}`])
      : undefined);
    return { ...verified, resolverSettlement: "verified" };
  }
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
    try {
      candidate = await makeSyncCandidate(input.runtimeRoot, git, expected.head, target, strategy);
    } catch (error) {
      if (!(error instanceof WorkspaceCandidateConflict) || !onConflict) throw error;
      const current = await inspectWorkspace(state, handle, generation);
      if (current?.workspace.observedCommit !== expected.head || current.workingTree !== "clean")
        throw syncConflict("head_changed", "The retained checkout changed during conflict detection");
      if (onConflict === "report") return conflictResult(error.paths);
      if (publish)
        await verifySyncPublicationLease({ git, source, publish, head: expected.head, privateRef: candidateRef + "-publication" });
      if (await observeWorkspaceTarget(source, expected.targetRef, git) !== target)
        throw syncConflict("target_ref_changed", "The exact target changed before resolver preparation");
      claimMutation();
      if (!preparedBefore) {
        const branch = (await observePreparedGitHead(workspace)).ref;
        if (branch === "HEAD")
          await executeWorkspaceGit([...git, "update-ref", resolverRef + "-detached", expected.head]);
        else if (isWorkspaceSourceRef(branch))
          await executeWorkspaceGit([...git, "symbolic-ref", resolverRef + "-branch", branch]);
        else
          throw syncConflict("head_changed", "The resolver requires the retained source branch");
        await executeWorkspaceGit([...git, "update-ref", resolverRef, expected.head, "0".repeat(expected.head.length)]);
      }
      return preparedResult(await applyResolverConflict(conflictShape));
    }
    if (publish && candidate !== expected.head)
      await verifySyncPublicationLease({
        git, source, publish, head: expected.head, privateRef: candidateRef + "-publication",
      });
  }

  claimMutation();
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
