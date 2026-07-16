import type { Dirent } from "node:fs";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TEST_WORKTREES_BASE = path.join(os.tmpdir(), "maister-test-worktrees");
const MAX_WORKTREE_DISCOVERY_DEPTH = 3;

export type TestWorktreeLane = "vitest" | "e2e" | "e2e-live";

type ManagedGitWorktree = {
  gitDirectory: string;
  worktreePath: string;
};

function assertSafeInvocationId(invocationId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,160}$/u.test(invocationId)) {
    throw new Error("test worktree invocation id must be a safe path segment");
  }
}

function assertTestWorktreesRoot(root: string): string {
  const resolvedBase = path.resolve(TEST_WORKTREES_BASE);
  const resolvedRoot = path.resolve(root);
  const relativeRoot = path.relative(resolvedBase, resolvedRoot);

  if (
    relativeRoot.length === 0 ||
    relativeRoot.startsWith(`..${path.sep}`) ||
    relativeRoot === ".." ||
    path.isAbsolute(relativeRoot)
  ) {
    throw new Error(
      "test worktree root must be a child of the managed test root",
    );
  }

  return resolvedRoot;
}

export function createTestWorktreesRoot(
  lane: TestWorktreeLane,
  invocationId: string = randomUUID(),
): string {
  assertSafeInvocationId(invocationId);

  return assertTestWorktreesRoot(
    path.join(TEST_WORKTREES_BASE, lane, invocationId),
  );
}

export function resolveTestWorktreesRoot(
  lane: TestWorktreeLane,
  environment: NodeJS.ProcessEnv,
): string {
  const configuredRoot = environment.MAISTER_WORKTREES_ROOT;

  if (configuredRoot !== undefined) {
    return assertTestWorktreesRoot(configuredRoot);
  }

  return createTestWorktreesRoot(lane);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function assertDirectoryIsNotSymlink(
  directoryPath: string,
): Promise<void> {
  const stat = await lstat(directoryPath);

  if (stat.isSymbolicLink()) {
    throw new Error("test worktree cleanup refuses symbolic-link directories");
  }
}

function parseGitDirectory(worktreePath: string, gitFile: string): string {
  const [firstLine] = gitFile.split(/\r?\n/u);
  const prefix = "gitdir: ";

  if (firstLine === undefined || !firstLine.startsWith(prefix)) {
    throw new Error("test worktree .git file has an invalid gitdir header");
  }

  const gitDirectory = path.resolve(
    worktreePath,
    firstLine.slice(prefix.length),
  );
  const worktreesDirectory = path.dirname(gitDirectory);
  const commonGitDirectory = path.dirname(worktreesDirectory);

  if (
    path.basename(worktreesDirectory) !== "worktrees" ||
    path.basename(commonGitDirectory) !== ".git"
  ) {
    throw new Error(
      "test worktree .git file does not point to a linked worktree",
    );
  }

  return gitDirectory;
}

async function discoverManagedGitWorktrees(
  directory: string,
  depth: number,
): Promise<ManagedGitWorktree[]> {
  await assertDirectoryIsNotSymlink(directory);

  const entries: Dirent[] = await readdir(directory, { withFileTypes: true });
  const gitFile = entries.find(
    (entry) => entry.name === ".git" && entry.isFile(),
  );

  if (gitFile !== undefined) {
    const gitFilePath = path.join(directory, gitFile.name);
    const gitDirectory = parseGitDirectory(
      directory,
      await readFile(gitFilePath, "utf8"),
    );

    return [{ gitDirectory, worktreePath: directory }];
  }

  if (depth >= MAX_WORKTREE_DISCOVERY_DEPTH) return [];

  const nestedDirectories = entries.filter(
    (entry) => entry.isDirectory() || entry.isSymbolicLink(),
  );
  const discovered = await Promise.all(
    nestedDirectories.map((entry) =>
      discoverManagedGitWorktrees(path.join(directory, entry.name), depth + 1),
    ),
  );

  return discovered.flat();
}

async function assertGitRegistryOwnership(
  worktree: ManagedGitWorktree,
): Promise<void> {
  const parentRepository = path.dirname(
    path.dirname(path.dirname(worktree.gitDirectory)),
  );
  const { stdout } = await execFileAsync(
    "git",
    ["-C", parentRepository, "worktree", "list", "--porcelain"],
    { maxBuffer: 1024 * 1024 },
  );
  const registeredPaths = stdout
    .split(/\r?\n/u)
    .flatMap((line) =>
      line.startsWith("worktree ")
        ? [path.resolve(line.slice("worktree ".length))]
        : [],
    );
  const canonicalWorktreePath = await realpath(worktree.worktreePath);
  const canonicalRegisteredPaths = await Promise.all(
    registeredPaths.map(
      async (registeredPath: string): Promise<string> =>
        realpath(registeredPath),
    ),
  );

  if (!canonicalRegisteredPaths.includes(canonicalWorktreePath)) {
    throw new Error(
      "test worktree cleanup found an unregistered linked worktree",
    );
  }

  await execFileAsync(
    "git",
    [
      "-C",
      parentRepository,
      "worktree",
      "remove",
      "--force",
      canonicalWorktreePath,
    ],
    { maxBuffer: 1024 * 1024 },
  );
}

export async function cleanupTestWorktrees(root: string): Promise<void> {
  const safeRoot = assertTestWorktreesRoot(root);

  try {
    await assertDirectoryIsNotSymlink(safeRoot);
  } catch (error) {
    if (isMissingPathError(error)) return;

    throw error;
  }

  const worktrees = await discoverManagedGitWorktrees(safeRoot, 0);

  for (const worktree of worktrees) {
    await assertGitRegistryOwnership(worktree);
  }

  await rm(safeRoot, { force: true, recursive: true });
}
