import "server-only";

import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { gitResult } from "./git";
import { MANIFEST_MAX_BYTES } from "./manifest";

import { atomicWriteJson, atomicWriteText } from "@/lib/atomic";
import { MaisterError } from "@/lib/errors";
import { worktreesRoot } from "@/lib/instance-config";

export const CONFIG_PERSISTENCE_DIRECTORY = ".config-persistence";
export const CONFIG_DIFF_MAX_BYTES = 2 * 1024 * 1024;

export type ConfigReviewFilesInput = {
  operationId: string;
  repoPath: string;
  source: string | null;
  proposed: string;
  manifestMode: string | null;
};

export type ConfigReviewFiles = { contentDirectory: string; diff: string };

function unsupportedStorage(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Configuration staging requires a private host-owned directory outside the project checkout. Check the worktree root and its permissions.",
    {
      details: { reason: "unsupported_checkout" },
    },
  );
}

/** Resolve an uncreated path through its nearest existing ancestor before writing. */
async function canonicalCandidate(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);

    if (parent === path) throw error;

    return join(await canonicalCandidate(parent), relative(parent, path));
  }
}

export async function configReviewRoot(repoPath: string): Promise<string> {
  if (
    (process.platform !== "darwin" && process.platform !== "linux") ||
    !isAbsolute(worktreesRoot())
  )
    throw unsupportedStorage();
  const candidate = resolve(worktreesRoot(), CONFIG_PERSISTENCE_DIRECTORY);
  const canonical = await canonicalCandidate(candidate);
  const project = await realpath(repoPath);
  const inside = relative(project, canonical);

  if (
    !inside ||
    (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
  )
    throw unsupportedStorage();
  await mkdir(candidate, { recursive: true, mode: 0o700 });
  const info = await lstat(candidate);

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(candidate)) !== canonical
  )
    throw unsupportedStorage();

  return canonical;
}

async function syncPrivateFile(path: string, mode: number): Promise<void> {
  await chmod(path, mode);
  const handle = await open(path, "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Durable private bytes precede the immutable DB review; the user checkout is read-only. */
export async function writeConfigReviewFiles(
  input: ConfigReviewFilesInput,
): Promise<ConfigReviewFiles> {
  z.string().uuid().parse(input.operationId);
  if (
    Buffer.byteLength(input.proposed, "utf8") > MANIFEST_MAX_BYTES ||
    (input.source !== null &&
      Buffer.byteLength(input.source, "utf8") > MANIFEST_MAX_BYTES)
  ) {
    throw new MaisterError(
      "CONFIG",
      "The manifest exceeds the 1 MiB review limit.",
      { details: { reason: "manifest_too_large" } },
    );
  }
  if (
    input.manifestMode !== null &&
    input.manifestMode !== "100644" &&
    input.manifestMode !== "100755"
  )
    throw unsupportedStorage();
  const root = await configReviewRoot(input.repoPath);
  const contentDirectory = join(root, input.operationId);

  await mkdir(contentDirectory, { mode: 0o700 });
  await atomicWriteJson(join(contentDirectory, "operation.json"), {
    version: 1,
    operationId: input.operationId,
    repoPath: await realpath(input.repoPath),
  });
  await syncPrivateFile(join(contentDirectory, "operation.json"), 0o600);
  const mode = input.manifestMode === "100755" ? 0o700 : 0o600;

  if (input.source !== null) {
    await atomicWriteText(join(contentDirectory, "before"), input.source);
    await syncPrivateFile(join(contentDirectory, "before"), mode);
  }
  await atomicWriteText(join(contentDirectory, "after"), input.proposed);
  await syncPrivateFile(join(contentDirectory, "after"), mode);
  const directoryHandle = await open(contentDirectory, "r");

  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  const result = await gitResult(contentDirectory, [
    "diff",
    "--no-index",
    "--text",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
    "--no-indent-heuristic",
    "--diff-algorithm=myers",
    "--unified=3",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--",
    input.source === null ? "/dev/null" : "before",
    "after",
  ]);

  if (result.code !== 0 && result.code !== 1)
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "The complete configuration diff could not be generated.",
      { details: { reason: "repository_unavailable" } },
    );
  const diff = result.stdout
    .replace(
      /^diff --git a\/(?:before|after) b\/after$/mu,
      "diff --git a/maister.yaml b/maister.yaml",
    )
    .replace(/^--- a\/before$/mu, "--- a/maister.yaml")
    .replace(/^\+\+\+ b\/after$/mu, "+++ b/maister.yaml");

  if (Buffer.byteLength(diff, "utf8") > CONFIG_DIFF_MAX_BYTES)
    throw new MaisterError(
      "CONFIG",
      "The complete diff exceeds the 2 MiB review limit; reduce the manifest and preview again.",
      { details: { reason: "diff_too_large" } },
    );

  return { contentDirectory, diff };
}
