import "server-only";
import { createHash } from "node:crypto";
import { lstat, readdir, readlink, readFile } from "node:fs/promises";
import path, { join, resolve as resolvePath } from "node:path";

export async function localDirectoryContentDigest(
  sourceDir: string,
  excludedNames: ReadonlySet<string> = new Set(),
): Promise<string> {
  const root = resolvePath(sourceDir);
  const entries = await listLocalDirectoryDigestEntries(root, excludedNames);
  const hash = createHash("sha256");

  for (const entry of entries) {
    hash.update(entry.kind);
    hash.update("\0");
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(entry.content);
    hash.update("\0");
  }

  return hash.digest("hex");
}

type LocalDirectoryDigestEntry = {
  kind: "file" | "symlink";
  relativePath: string;
  content: string;
};

async function listLocalDirectoryDigestEntries(
  root: string,
  excludedNames: ReadonlySet<string>,
): Promise<LocalDirectoryDigestEntry[]> {
  const entries: LocalDirectoryDigestEntry[] = [];

  async function walk(dir: string): Promise<void> {
    const dirEntries = await readdir(dir, { withFileTypes: true });

    for (const entry of dirEntries) {
      if (excludedNames.has(entry.name)) continue;
      const absolutePath = join(dir, entry.name);
      const relativePath = path
        .relative(root, absolutePath)
        .split(path.sep)
        .join("/");

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        entries.push({
          kind: "symlink",
          relativePath,
          content: await readlink(absolutePath),
        });
        continue;
      }
      if (entry.isFile()) {
        const content = await readFile(absolutePath);

        entries.push({
          kind: "file",
          relativePath,
          content: content.toString("base64"),
        });
      }
    }
  }

  await walk(root);

  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** Verified source files may coexist with historical platform-added schemas
 * or setup outputs. Only the recorded physical owner can adopt such a cache. */
export async function containsSourceMaterial(
  source: string,
  target: string,
): Promise<boolean> {
  async function matches(from: string, to: string): Promise<boolean> {
    const original = await lstat(from);
    const installed = await lstat(to).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });

    if (!installed) return false;
    if (original.isSymbolicLink())
      return (
        installed.isSymbolicLink() &&
        (await readlink(from)) === (await readlink(to))
      );
    if (original.isDirectory()) {
      if (!installed.isDirectory()) return false;
      const names = await readdir(from);

      if (
        from === source &&
        !names.includes("setup.sh") &&
        (await readdir(to)).includes("setup.sh")
      )
        return false;
      for (const name of names) {
        if (
          name !== ".git" &&
          !(await matches(join(from, name), join(to, name)))
        )
          return false;
      }

      return true;
    }

    return (
      original.isFile() &&
      installed.isFile() &&
      (original.mode & 0o111) === (installed.mode & 0o111) &&
      (await readFile(from)).equals(await readFile(to))
    );
  }

  return matches(source, target);
}
