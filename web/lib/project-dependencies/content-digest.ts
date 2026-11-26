import "server-only";
import { createHash } from "node:crypto";
import { lstat, readdir, readlink, readFile, realpath } from "node:fs/promises";
import path, { join, resolve as resolvePath } from "node:path";

import { MaisterError } from "@/lib/errors";

function unsafeLink(): never {
  throw new MaisterError(
    "CONFIG",
    "A package link must resolve inside the copied source tree.",
    {
      details: { reason: "material_link_outside_source" },
    },
  );
}

function insideSource(root: string, target: string): boolean {
  const relative = path.relative(root, target);

  return (
    !path.isAbsolute(relative) &&
    !relative
      .split(path.sep)
      .some((part) => part === ".." || part.toLowerCase() === ".git")
  );
}

/** Resolve an explicitly selected package subdirectory against its canonical source root. */
export async function confinedPackageDirectory(
  root: string,
  subpath: string,
): Promise<string> {
  if (
    subpath
      .split("/")
      .some((segment) => segment.toLowerCase() === ".git" || segment === "..")
  )
    unsafeLink();
  const canonical = await realpath(root);
  const selected = await realpath(join(canonical, subpath));

  if (!insideSource(canonical, selected)) unsafeLink();

  return selected;
}

/** Bind executable bits and tree shape alongside legacy byte-only revisions.
 * Validate links in the same tree that will be copied or accepted for review. */
export async function materialLayoutDigest(directory: string): Promise<string> {
  const root = await realpath(directory);
  const entries: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const location = join(dir, entry.name);
      const name = path.relative(root, location).split(path.sep).join("/");

      if (entry.isSymbolicLink()) {
        const link = await readlink(location);

        if (
          path.isAbsolute(link) ||
          !insideSource(root, resolvePath(dir, link))
        )
          unsafeLink();
        let physical: string;

        try {
          physical = await realpath(location);
        } catch (error) {
          if (
            ["ENOENT", "ENOTDIR", "ELOOP"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            unsafeLink();
          throw error;
        }
        if (!insideSource(root, physical)) unsafeLink();
        entries.push(JSON.stringify(["link", name, link]));
      } else if (entry.isDirectory()) {
        entries.push(JSON.stringify(["dir", name]));
        await walk(location);
      } else if (entry.isFile()) {
        entries.push(
          JSON.stringify(["file", name, (await lstat(location)).mode & 0o111]),
        );
      } else unsafeLink();
    }
  }
  await walk(root);

  return createHash("sha256")
    .update(JSON.stringify(entries.sort()))
    .digest("hex");
}

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
