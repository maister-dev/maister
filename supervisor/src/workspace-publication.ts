import type {
  WorkspaceEvidenceFile,
  WorkspacePublicationRequest,
  WorkspacePublicationSnapshot,
} from "../../runtime/workspace-publication";
import type { WorkspaceRow } from "./host-state";
import type { Logger } from "pino";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { branchNameViolation } from "../../runtime/git-branch";
import { isMaisterError } from "../../runtime/maister-error";
import { selectPrAdapter } from "../../runtime/pull-request";
import { detectProvider } from "../../runtime/repository-url";
import { GIT_OBJECT_ID } from "../../runtime/wait-head";
import { normalizePublicationOrigin } from "../../runtime/workspace-publication";

import { SupervisorError } from "./types";

const exec = promisify(execFile);

async function git(
  handle: WorkspaceRow,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await exec(
      "git",
      ["--no-pager", "--no-optional-locks", "-C", handle.realPath, ...args],
      {
        encoding: "utf8",
        timeout: 8000,
        maxBuffer: 16 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );

    return stdout.trim();
  } catch {
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      "Publication Git operation did not complete",
      {
        details: { runId: handle.runId },
      },
    );
  }
}

async function readRemoteHead(
  handle: WorkspaceRow,
  remote: string,
  headRef: string,
): Promise<string | null> {
  const advertised = await git(handle, [
    "ls-remote",
    "--refs",
    "--heads",
    "--",
    remote,
    headRef,
  ]);

  if (!advertised) return null;
  const [sha, ref] = advertised.split("\t");

  if (!GIT_OBJECT_ID.test(sha) || ref !== headRef)
    throw new SupervisorError(
      "PRECONDITION",
      "Unverified remote publication ref",
    );

  return sha;
}

async function readPublicationTarget(
  handle: WorkspaceRow,
  remote: string,
  headRef: string,
): Promise<{
  snapshot: WorkspacePublicationSnapshot;
  url: string;
}> {
  if (handle.releasedAt !== null || handle.kind !== "git_worktree")
    throw new SupervisorError(
      "PRECONDITION",
      "Publication requires an adopted Git worktree",
    );
  await git(handle, ["check-ref-format", headRef]);

  const [headSha, dirty, origin] = await Promise.all([
    git(handle, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(handle, ["status", "--porcelain=v1"]),
    git(handle, ["remote", "get-url", "--push", "--all", "--", remote]),
  ]);

  if (!GIT_OBJECT_ID.test(headSha) || dirty)
    throw new SupervisorError(
      "PRECONDITION",
      "Publication requires a clean, committed worktree",
    );

  const repoIdentity = origin.includes("\n")
    ? null
    : normalizePublicationOrigin(origin);

  if (!repoIdentity)
    throw new SupervisorError(
      "PRECONDITION",
      "Unsupported Git publication origin",
    );

  return {
    url: origin,
    snapshot: {
      headSha,
      repoIdentity,
      remoteHeadSha: await readRemoteHead(handle, origin, headRef),
    },
  };
}

async function observeWorkspacePublication(
  handle: WorkspaceRow,
  remote: string,
  headRef: string,
): Promise<WorkspacePublicationSnapshot> {
  return (await readPublicationTarget(handle, remote, headRef)).snapshot;
}

function parseEvidenceFiles(output: string): WorkspaceEvidenceFile[] {
  if (!output) return [];
  const records = output.split("\0");
  const files: WorkspaceEvidenceFile[] = [];

  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index];
    const separator = record.indexOf("\t");
    const pathStart = record.indexOf("\t", separator + 1);
    const additions = record.slice(0, separator);
    const deletions = record.slice(separator + 1, pathStart);
    const validCount = /^(?:0|[1-9][0-9]*|-)$/;

    if (
      separator < 1 ||
      pathStart <= separator ||
      !validCount.test(additions) ||
      !validCount.test(deletions)
    )
      throw new SupervisorError(
        "PRECONDITION",
        "Git returned an invalid evidence diff",
      );
    const named = record.slice(pathStart + 1);
    const oldPath = named ? undefined : records[++index];
    const path = named || records[++index];

    if (!path || (!named && !oldPath))
      throw new SupervisorError(
        "PRECONDITION",
        "Git returned an incomplete evidence diff",
      );
    const binary = additions === "-" || deletions === "-";

    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      status: oldPath ? "R" : "M",
      additions: binary ? 0 : Number(additions),
      deletions: binary ? 0 : Number(deletions),
      binary,
    });
  }

  return files;
}

async function observeWorkspaceEvidence(
  handle: WorkspaceRow,
  remote: string,
  baseRef: string,
): Promise<WorkspacePublicationSnapshot> {
  await git(handle, ["check-ref-format", baseRef]);
  const [headSha, baseSha, initialStatus, origin] = await Promise.all([
    git(handle, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(handle, ["rev-parse", "--verify", `${baseRef}^{commit}`]),
    git(handle, ["status", "--porcelain=v1"]),
    git(handle, ["remote", "get-url", "--push", "--all", "--", remote]),
  ]);
  const repoIdentity = origin.includes("\n")
    ? null
    : normalizePublicationOrigin(origin);

  if (
    !repoIdentity ||
    !GIT_OBJECT_ID.test(headSha) ||
    !GIT_OBJECT_ID.test(baseSha)
  )
    throw new SupervisorError(
      "PRECONDITION",
      "Git evidence lacks an exact candidate and base",
    );
  const files = parseEvidenceFiles(
    await git(handle, [
      "diff",
      "--no-ext-diff",
      "--numstat",
      "-z",
      "-M",
      baseSha,
      headSha,
      "--",
    ]),
  );
  const [finalHead, finalBase, finalStatus] = await Promise.all([
    git(handle, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(handle, ["rev-parse", "--verify", `${baseRef}^{commit}`]),
    git(handle, ["status", "--porcelain=v1"]),
  ]);

  if (finalHead !== headSha || finalBase !== baseSha)
    throw new SupervisorError(
      "PRECONDITION",
      "Git evidence refs changed while being observed",
    );

  return {
    headSha,
    repoIdentity,
    remoteHeadSha: null,
    evidence: { baseSha, clean: !initialStatus && !finalStatus, files },
  };
}
async function pushWorkspacePublication(
  handle: WorkspaceRow,
  request: Extract<WorkspacePublicationRequest, { action: "push" }>,
  assertCurrentFence: () => void,
): Promise<WorkspacePublicationSnapshot> {
  const { snapshot: before, url } = await readPublicationTarget(
    handle,
    request.remote,
    request.headRef,
  );

  if (
    before.headSha !== request.expectedHead ||
    before.repoIdentity !== request.repoIdentity
  )
    throw new SupervisorError(
      "PRECONDITION",
      "Publication source or origin has changed",
    );
  if (before.remoteHeadSha === request.expectedHead) return before;
  if (before.remoteHeadSha !== request.expectedRemoteHead)
    throw new SupervisorError(
      "PRECONDITION",
      "Publication remote head no longer matches the claim",
    );
  if (before.remoteHeadSha)
    await git(handle, [
      "merge-base",
      "--is-ancestor",
      before.remoteHeadSha,
      before.headSha,
    ]);

  assertCurrentFence();
  // The lease names the exact observed prior ref and the pinned source commit.
  await git(handle, [
    "push",
    "--porcelain",
    `--force-with-lease=${request.headRef}:${request.expectedRemoteHead ?? ""}`,
    "--",
    url,
    `${request.expectedHead}:${request.headRef}`,
  ]);
  const remoteHeadSha = await readRemoteHead(handle, url, request.headRef);

  if (remoteHeadSha !== request.expectedHead)
    throw new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      "Publication effect is not confirmed at the expected remote ref",
    );

  return { ...before, remoteHeadSha };
}

async function openWorkspacePullRequest(
  handle: WorkspaceRow,
  request: Extract<WorkspacePublicationRequest, { action: "open_pr" }>,
  assertCurrentFence: () => void,
  logger: Logger,
): Promise<WorkspacePublicationSnapshot> {
  const sourceBranch = request.headRef.slice("refs/heads/".length);
  const targetBranch = request.baseRef.slice("refs/heads/".length);

  if (
    sourceBranch === targetBranch ||
    branchNameViolation(sourceBranch) ||
    branchNameViolation(targetBranch)
  )
    throw new SupervisorError(
      "PRECONDITION",
      "Publication PR branch is invalid",
    );

  const signal = AbortSignal.timeout(38_000);
  const observeExactSource = async () => {
    const target = await readPublicationTarget(
      handle,
      request.remote,
      request.headRef,
    );
    const { snapshot } = target;

    if (
      snapshot.repoIdentity !== request.repoIdentity ||
      snapshot.headSha !== request.expectedHead ||
      snapshot.remoteHeadSha !== request.expectedHead
    )
      throw new SupervisorError(
        "PRECONDITION",
        "The published PR source no longer matches",
      );

    assertCurrentFence();
    if (signal.aborted)
      throw new SupervisorError(
        "EXECUTOR_UNAVAILABLE",
        "Publication PR command expired",
      );

    return target;
  };

  const { snapshot, url } = await observeExactSource();
  const provider = detectProvider(url);

  try {
    const adapter = selectPrAdapter(provider, {
      remoteUrl: url,
      logger,
      credential: request.credential,
    });

    await adapter.preflight(signal);
    const pullRequest = await adapter.createOrUpdatePr({
      repoPath: handle.realPath,
      remote: request.remote,
      sourceBranch,
      targetBranch,
      providerRepository:
        provider === "github"
          ? request.repoIdentity
          : `https://${request.repoIdentity}`,
      title: request.title,
      body: request.body,
      draft: request.draft,
      signal,
      beforeWrite: async () => {
        await observeExactSource();
      },
    });

    await observeExactSource();
    logger.info(
      {
        runId: handle.runId,
        prNumber: pullRequest.number,
        reused: pullRequest.reused,
      },
      "fenced publication PR observed",
    );

    return { ...snapshot, pullRequest };
  } catch (error: unknown) {
    if (isMaisterError(error))
      throw new SupervisorError(
        error.code === "PRECONDITION" ? "PRECONDITION" : "EXECUTOR_UNAVAILABLE",
        error.message,
      );
    throw error;
  }
}

export async function executeWorkspacePublication(
  handle: WorkspaceRow,
  command: WorkspacePublicationRequest,
  assertCurrentFence: () => void,
  logger: Logger,
): Promise<WorkspacePublicationSnapshot> {
  switch (command.action) {
    case "inspect":
      return observeWorkspacePublication(
        handle,
        command.remote,
        command.headRef,
      );
    case "evidence":
      return observeWorkspaceEvidence(handle, command.remote, command.headRef);
    case "push":
      return pushWorkspacePublication(handle, command, assertCurrentFence);
    case "open_pr":
      return openWorkspacePullRequest(
        handle,
        command,
        assertCurrentFence,
        logger,
      );
  }
}
