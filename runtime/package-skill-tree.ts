import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { MaisterError } from "./maister-error";

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
      digest.update(JSON.stringify(["directory", relativeName]));
      for (const name of (await readdir(full)).sort())
        await visit(join(relativeName, name));
      ancestors.delete(full);
    } else if (stat.isFile()) {
      digest.update(
        JSON.stringify([
          "file",
          relativeName,
          createHash("sha256")
            .update(await readFile(full))
            .digest("hex"),
        ]),
      );
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
