import "server-only";

import type { ConfigPersistSnapshot } from "./types";
import type { ConfigOperation } from "./store";
import type { RepositoryObservation } from "./status";

import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { git } from "./git";
import { inspectRepository } from "./status";

import { MaisterError } from "@/lib/errors";
import { contentDigest, sha256 } from "@/lib/evaluations/digest";

function uncertain(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "Repository state is not an exact recorded publication state. Preserve files and Git locks, inspect this operation, then request recovery after resolving the conflict.",
    { details: { reason: "recovery_required" } },
  );
}

const GIT_OPERATION_PATHS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
  "BISECT_LOG",
  "sequencer",
] as const;

async function assertOperationPathsAbsent(
  repo: string,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    const path = resolve(
      repo,
      (await git(repo, ["rev-parse", "--git-path", name])).trim(),
    );

    try {
      await lstat(path);
      throw uncertain();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Only the proven new manifest/index pair may complete forward after interruption. */
async function observePartialPublication(
  operation: Pick<ConfigOperation, "snapshot" | "preparedSha">,
): Promise<RepositoryObservation> {
  const snapshot = operation.snapshot;
  const repo = snapshot.repository.repoPath;
  const observed = await inspectRepository({
    repoPath: repo,
    mainBranch: snapshot.repository.branch,
  });

  if (
    !operation.preparedSha ||
    observed.repository.head !== snapshot.repository.head ||
    observed.repository.branch !== snapshot.repository.branch ||
    observed.repository.commonDirectory !==
      snapshot.repository.commonDirectory ||
    observed.repository.configDigest !== snapshot.repository.configDigest
  )
    throw uncertain();
  const expectedIndex = await indexAtConfigCommit(repo, operation.preparedSha);

  if (observed.repository.indexEntries !== expectedIndex) throw uncertain();
  const changes = observed.repository.status.split("\0").filter(Boolean);

  if (changes.length !== 1 || changes[0]!.slice(3) !== "maister.yaml")
    throw uncertain();
  const target = join(repo, "maister.yaml");
  const info = await lstat(target);

  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (info.mode & 0o111 ? "100755" : "100644") !==
      (snapshot.repository.manifestMode ?? "100644") ||
    sha256(await readFile(target, "utf8")) !== snapshot.proposedDigest
  )
    throw uncertain();

  return observed;
}

/** The caller holds Git's HEAD/branch ref transaction; no unknown operation is ignored. */
export async function assertPublicationSeam(
  snapshot: ConfigPersistSnapshot,
): Promise<void> {
  const repo = snapshot.repository.repoPath;
  const observed = await inspectRepository({
    repoPath: repo,
    mainBranch: snapshot.repository.branch,
  });

  if (contentDigest(observed.repository) !== contentDigest(snapshot.repository))
    throw uncertain();
  if (observed.blocker && observed.blocker !== "operation_in_progress")
    throw uncertain();
  await assertOperationPathsAbsent(repo, [
    ...GIT_OPERATION_PATHS,
    "index.lock",
  ]);
}

export async function inspectPartialPublication(
  operation: ConfigOperation,
): Promise<"old" | "new"> {
  const snapshot = operation.snapshot;
  const observed = await inspectRepository({
    repoPath: snapshot.repository.repoPath,
    mainBranch: snapshot.repository.branch,
  });

  if (
    !observed.blocker &&
    contentDigest(observed.repository) === contentDigest(snapshot.repository)
  )
    return "old";
  if (observed.blocker && observed.blocker !== "dirty_checkout")
    throw uncertain();
  await observePartialPublication(operation);

  return "new";
}

export async function assertPartialPublicationSeam(
  operation: ConfigOperation,
): Promise<void> {
  const observed = await observePartialPublication(operation);

  if (
    observed.blocker &&
    observed.blocker !== "dirty_checkout" &&
    observed.blocker !== "operation_in_progress"
  )
    throw uncertain();
  const repo = operation.snapshot.repository.repoPath;

  await assertOperationPathsAbsent(repo, [
    ...GIT_OPERATION_PATHS,
    "index.lock",
  ]);
}

/** Closing an unpublished intent never rewrites a repository that an operator changed. */
export async function unpublishedOperationCanClose(
  operation: ConfigOperation,
): Promise<boolean> {
  const snapshot = operation.snapshot;
  const observed = await inspectRepository({
    repoPath: snapshot.repository.repoPath,
    mainBranch: snapshot.repository.branch,
  });

  if (observed.blocker === "operation_in_progress") return false;
  if (observed.repository.head !== snapshot.repository.head)
    return observed.repository.status === "";
  if (observed.repository.indexEntries !== snapshot.repository.indexEntries)
    return false;
  try {
    const path = join(snapshot.repository.repoPath, "maister.yaml");
    const info = await lstat(path);

    return (
      info.isFile() &&
      !info.isSymbolicLink() &&
      sha256(await readFile(path, "utf8")) ===
        snapshot.repository.manifestDigest &&
      (info.mode & 0o111 ? "100755" : "100644") ===
        snapshot.repository.manifestMode
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return snapshot.repository.manifestDigest === null;
    throw error;
  }
}

async function indexAtConfigCommit(repo: string, sha: string): Promise<string> {
  const tree = await git(repo, [
    "-c",
    "core.quotePath=true",
    "ls-tree",
    "-r",
    "--full-tree",
    sha,
  ]);
  const entries = tree
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-7]{6}) (?:blob|commit) ([0-9a-f]{40})\t(.+)$/u.exec(
        line,
      );

      if (!match) throw uncertain();

      return `H ${match[1]} ${match[2]} 0\t${match[3]}\n`;
    })
    .join("");

  return Buffer.from(entries, "ascii").toString("base64");
}

/** The caller holds its proven standard index lock and the prepared HEAD ref transaction. */
export async function assertReservedPublicationSeam(
  snapshot: ConfigPersistSnapshot,
  preparedSha: string,
): Promise<void> {
  const observed = await observePartialPublication({ snapshot, preparedSha });

  if (
    observed.blocker &&
    observed.blocker !== "dirty_checkout" &&
    observed.blocker !== "operation_in_progress"
  )
    throw uncertain();
  const repo = snapshot.repository.repoPath;

  await assertOperationPathsAbsent(repo, GIT_OPERATION_PATHS);
}
