import "server-only";

import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { isMaisterError, MaisterError } from "@/lib/errors";

/** An unknown historical workspace must be preserved, never terminalized without its owner. */
export function isPreparationIdentityRefusal(error: unknown): boolean {
  return (
    isMaisterError(error) &&
    error.details?.reason === "operational_preparation_identity_changed"
  );
}

function missing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function unsafeDirectory(): MaisterError {
  return new MaisterError(
    "PRECONDITION",
    "Workspace preparation requires a real directory; preserve unsafe paths for diagnosis",
    {
      details: { reason: "operational_preparation_path_unsafe" },
    },
  );
}

/** Ancestor aliases are allowed; absent suffixes are resolved without creating them. */
async function canonicalAncestor(candidate: string): Promise<string> {
  let metadata: Awaited<ReturnType<typeof lstat>>;

  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if (!missing(error) || path.dirname(candidate) === candidate) throw error;

    return path.join(
      await canonicalAncestor(path.dirname(candidate)),
      path.basename(candidate),
    );
  }
  const canonical = await realpath(candidate);

  if (
    !(
      metadata.isSymbolicLink() ? await lstat(canonical) : metadata
    ).isDirectory()
  )
    throw unsafeDirectory();

  return canonical;
}

/** Match the materialization root policy, including before a workspace exists. */
export async function canonicalPreparationPath(cwd: string): Promise<string> {
  const candidate = path.resolve(cwd);
  let metadata: Awaited<ReturnType<typeof lstat>>;

  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if (!missing(error)) throw error;

    return path.join(
      await canonicalAncestor(path.dirname(candidate)),
      path.basename(candidate),
    );
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw unsafeDirectory();

  return realpath(candidate);
}

/** Physical operation identity is independent of immutable allocation hashes. */
export async function agentPreparationResourceId(
  input: Readonly<{
    repoPath: string;
    cwd: string;
  }>,
): Promise<string> {
  const [repository, cwd] = await Promise.all([
    realpath(input.repoPath),
    canonicalPreparationPath(input.cwd),
  ]);

  return createHash("sha256").update(`${repository}\0${cwd}`).digest("hex");
}
