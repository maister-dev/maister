import "server-only";

import { realpath } from "node:fs/promises";
import path from "node:path";

import { MaisterError } from "@/lib/errors";
import { localPackagesRoot } from "@/lib/instance-config";

// (ADR-096) Absolute working-dir for a local package, derived from its slug —
// symmetric with the flows/worktrees roots. NEVER projected to clients.
export function localPackageWorkingDir(slug: string): string {
  return path.join(localPackagesRoot(), slug);
}

// (ADR-096) kebab a display name into a working-dir-safe slug stem.
export function slugifyName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

  return base.length > 0 ? base : "package";
}

// (ADR-096, D5) Confine an UNTRUSTED (url/body-controlled) artifact path to the
// package working dir. Rejects absolute, leading-dash, NUL, `..`, and `.git/`
// segments lexically, then re-checks against the realpath of the working dir and
// of the resolved file's parent (symlink-escape guard). Throws PRECONDITION on
// escape; CONFIG when the working dir itself is gone. Returns the resolved path.
export async function resolveWithinWorkingDir(
  workingDir: string,
  relPath: string,
): Promise<string> {
  if (
    !relPath ||
    relPath.includes("\0") ||
    relPath.startsWith("-") ||
    path.isAbsolute(relPath)
  ) {
    throw new MaisterError(
      "PRECONDITION",
      `invalid artifact path: ${JSON.stringify(relPath)}`,
    );
  }

  const parts = relPath.split(/[\\/]+/).filter((p) => p.length > 0);

  if (parts.some((p) => p === ".." || p === "." || p === ".git")) {
    throw new MaisterError(
      "PRECONDITION",
      `artifact path escapes the working dir: ${relPath}`,
    );
  }

  let realRoot: string;

  try {
    realRoot = await realpath(workingDir);
  } catch {
    throw new MaisterError(
      "CONFIG",
      `local-package working dir is missing: ${workingDir}`,
    );
  }

  const resolved = path.join(realRoot, ...parts);

  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
    throw new MaisterError(
      "PRECONDITION",
      `artifact path escapes the working dir: ${relPath}`,
    );
  }

  // `mkdir(…, { recursive: true })` and the file/git write that follow will
  // FOLLOW a symlink in any ALREADY-EXISTING path segment, so realpath-ing only
  // the immediate parent (and lexically falling back when it does not exist yet)
  // is insufficient: a working dir containing `link -> /outside` lets
  // `link/newdir/file` escape — `newdir` is created UNDER the symlink target.
  // Walk up to the NEAREST EXISTING ancestor and realpath IT; the leaf segments
  // that do not exist yet are created fresh under a real dir, never followed.
  // realRoot itself exists (realpath'd above), so the walk terminates inside it.
  let ancestor = path.dirname(resolved);

  for (;;) {
    let realAncestor: string;

    try {
      realAncestor = await realpath(ancestor);
    } catch {
      const parent = path.dirname(ancestor);

      if (parent === ancestor) break; // fs root — unreachable (realRoot exists)
      ancestor = parent;
      continue;
    }

    if (
      realAncestor !== realRoot &&
      !realAncestor.startsWith(realRoot + path.sep)
    ) {
      throw new MaisterError(
        "PRECONDITION",
        `artifact path escapes the working dir (symlink): ${relPath}`,
      );
    }
    break;
  }

  // Leaf-symlink guard: if the FINAL path already exists, realpath it (follows
  // any symlink) and require the real target to stay within the root — closes
  // symlink-LEAF read/write/copy escapes that the ancestor walk above (which
  // only covers not-yet-created intermediates) misses. A not-yet-existing leaf
  // (a new file / import entry) realpath-throws → skipped, which is correct
  // (nothing to follow yet; the validated ancestor will hold it).
  const realLeaf = await realpath(resolved).catch(() => null);

  if (
    realLeaf !== null &&
    realLeaf !== realRoot &&
    !realLeaf.startsWith(realRoot + path.sep)
  ) {
    throw new MaisterError(
      "PRECONDITION",
      `artifact path escapes the working dir (symlink): ${relPath}`,
    );
  }

  return resolved;
}
