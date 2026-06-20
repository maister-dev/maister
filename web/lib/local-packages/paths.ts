import "server-only";

import { realpath } from "node:fs/promises";
import path from "node:path";

import { MaisterError } from "@/lib/errors";
import { localPackagesRoot } from "@/lib/instance-config";

// (ADR-093) Absolute working-dir for a local package, derived from its slug —
// symmetric with the flows/worktrees roots. NEVER projected to clients.
export function localPackageWorkingDir(slug: string): string {
  return path.join(localPackagesRoot(), slug);
}

// (ADR-093) kebab a display name into a working-dir-safe slug stem.
export function slugifyName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);

  return base.length > 0 ? base : "package";
}

// (ADR-093, D5) Confine an UNTRUSTED (url/body-controlled) artifact path to the
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

  const parentReal = await realpath(path.dirname(resolved)).catch(() =>
    path.dirname(resolved),
  );

  if (parentReal !== realRoot && !parentReal.startsWith(realRoot + path.sep)) {
    throw new MaisterError(
      "PRECONDITION",
      `artifact path escapes the working dir (symlink): ${relPath}`,
    );
  }

  return resolved;
}
