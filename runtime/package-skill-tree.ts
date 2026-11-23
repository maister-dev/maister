import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Hash the relative names and bytes in an already confined, regular-file tree. */
export async function packageSkillTreeDigest(
  directory: string,
): Promise<string> {
  const digest = createHash("sha256");
  async function visit(relative: string): Promise<void> {
    const full = join(directory, relative);
    const stat = await lstat(full);
    if (stat.isDirectory()) {
      digest.update(JSON.stringify(["directory", relative]));
      for (const name of (await readdir(full)).sort())
        await visit(join(relative, name));
    } else if (stat.isFile()) {
      digest.update(
        JSON.stringify([
          "file",
          relative,
          createHash("sha256")
            .update(await readFile(full))
            .digest("hex"),
        ]),
      );
    } else
      throw new Error(
        "A package skill tree contains a symlink or special file",
      );
  }
  await visit("");
  return digest.digest("hex");
}

export type PackageSkillView = {
  skillsDigest: string;
  settingsDigest?: string;
};
