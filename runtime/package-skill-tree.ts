import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { MaisterError } from "./maister-error";

export const ADDRESSED_PACKAGE_SKILL_SLUG =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export type AddressedPackageSkill = Readonly<{
  slug: string;
  treeDigest: string;
}>;

type DigestEntry =
  readonly ["directory", string] | readonly ["file", string, string];

function updateDigest(
  digest: ReturnType<typeof createHash>,
  entry: DigestEntry,
): void {
  digest.update(JSON.stringify(entry));
}

/** A captured Git tree has no empty directories. Rebuild its walk from sealed file hashes. */
export function packageSkillManifestDigest(
  files: readonly Readonly<{ path: string; sha256: string }>[],
): string {
  const entries = new Map<string, DigestEntry>([["", ["directory", ""]]]);

  for (const { path, sha256 } of files) {
    const parts = path.split("/");
    const name = join(...parts);

    for (let depth = 1; depth < parts.length; depth += 1) {
      const directory = join(...parts.slice(0, depth));

      entries.set(directory, ["directory", directory]);
    }
    entries.set(name, ["file", name, sha256]);
  }
  const byTreeOrder = (
    [, left]: DigestEntry,
    [, right]: DigestEntry,
  ): number => {
    const a = left.split(sep);
    const b = right.split(sep);

    for (let depth = 0; depth < Math.min(a.length, b.length); depth += 1) {
      if (a[depth] !== b[depth]) return a[depth] < b[depth] ? -1 : 1;
    }

    return a.length - b.length;
  };
  const digest = createHash("sha256");

  for (const entry of [...entries.values()].sort(byTreeOrder))
    updateDigest(digest, entry);

  return digest.digest("hex");
}

export async function confinedPackageSkillPath(
  root: string,
  file: string,
): Promise<string> {
  const target = await realpath(file);
  const name = relative(root, target);
  if (name === ".." || name.startsWith(".." + sep) || isAbsolute(name))
    throw new MaisterError(
      "CONFIG",
      "Package skill companion resolves outside its pin",
    );
  return target;
}

/** Hash the companion bytes a reader sees, using their names in the skill directory. */
async function digestTree(
  directory: string,
  resolveEntry: (file: string) => Promise<string>,
): Promise<string> {
  const digest = createHash("sha256");
  const ancestors = new Set<string>();
  async function visit(relativeName: string): Promise<void> {
    const full = await resolveEntry(join(directory, relativeName));
    const stat = await lstat(full);
    if (stat.isDirectory()) {
      if (ancestors.has(full))
        throw new MaisterError(
          "CONFIG",
          "Package skill companion contains a directory cycle",
        );
      ancestors.add(full);
      updateDigest(digest, ["directory", relativeName]);
      for (const name of (await readdir(full)).sort())
        await visit(join(relativeName, name));
      ancestors.delete(full);
    } else if (stat.isFile()) {
      updateDigest(digest, [
        "file",
        relativeName,
        createHash("sha256")
          .update(await readFile(full))
          .digest("hex"),
      ]);
    } else
      throw new MaisterError(
        "CONFIG",
        "A package skill tree contains a symlink or special file",
      );
  }
  await visit("");
  return digest.digest("hex");
}

/** Destination witnesses must contain regular files and directories only. */
export function packageSkillTreeDigest(directory: string): Promise<string> {
  return digestTree(directory, async (file) => file);
}

/** Source links may address companions inside the same immutable bundle. */
export async function packageSkillSourceDigest(
  directory: string,
  bundle: string,
): Promise<string> {
  const root = await realpath(bundle);
  return digestTree(directory, (file) => confinedPackageSkillPath(root, file));
}

export type PackageSkillView = {
  skillsDigest: string;
  settingsDigest?: string;
};
