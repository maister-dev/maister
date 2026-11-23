import "server-only";
import {createHash} from "node:crypto";
import {readdir,readlink,readFile} from "node:fs/promises";
import path,{join,resolve as resolvePath} from "node:path";

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

