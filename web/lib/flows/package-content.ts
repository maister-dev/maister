import "server-only";

import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import pino from "pino";
import { z } from "zod";

import { classifyPackageFile } from "@/lib/flows/package-authoring";

const log = pino({
  name: "package-content",
  level: process.env.LOG_LEVEL ?? "info",
});

const MAX_FILE_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

// Mirrors worktree.ts repoRelPathSchema: the `?file=` rel-path is query-controlled
// and UNTRUSTED. Reject traversal (`..`), absolute / leading-`/`, leading-`-`
// (option injection), and NUL before any fs call — sink-invariant validation, not
// just `z.string()` shape (skill-context: validate at the sink's invariant).
const relPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes("\0"), "no NUL")
  .refine((p) => !p.startsWith("/"), "must be relative")
  .refine((p) => !p.startsWith("-"), "no leading dash")
  .refine((p) => !p.split("/").includes(".."), "no .. segment");

type InstalledPackageRef = { installedPath: string };

type PackageFileEntry = { path: string; kind: string; size: number };

type ListResult =
  | { bundleMissing: true }
  | {
      bundleMissing: false;
      files: PackageFileEntry[];
      flowYaml: string | null;
    };

type ReadState =
  | "text"
  | "binary"
  | "too-large"
  | "not-found"
  | "bundle-missing";

type ReadResult = { state: ReadState; content?: string; kind?: string };

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function walkRegularFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      out.push(path.relative(root, abs));
    }
  }

  await walk(root);

  return out;
}

export async function listInstalledPackageFiles(
  args: InstalledPackageRef,
): Promise<ListResult> {
  const { installedPath } = args;

  let relPaths: string[];

  try {
    relPaths = await walkRegularFiles(installedPath);
  } catch (err) {
    if (isEnoent(err)) {
      log.warn({ reason: "bundle-missing" }, "package bundle missing on disk");

      return { bundleMissing: true };
    }
    throw err;
  }

  const files: PackageFileEntry[] = [];
  let flowYaml: string | null = null;

  for (const relPath of relPaths) {
    const { size } = await stat(path.join(installedPath, relPath));

    if (relPath === "flow.yaml") {
      // Cap the raw flow.yaml read too (not only readInstalledPackageFile) — an
      // oversized regular file would otherwise stream unbounded into memory.
      if (size > MAX_FILE_BYTES) {
        log.warn(
          { reason: "flow-yaml-too-large", size },
          "flow.yaml exceeds size cap; omitted",
        );
        continue;
      }
      flowYaml = await readFile(path.join(installedPath, relPath), "utf8");
      continue;
    }

    files.push({ path: relPath, kind: classifyPackageFile(relPath), size });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  log.debug({ fileCount: files.length }, "package files listed");

  return { bundleMissing: false, files, flowYaml };
}

export async function readInstalledPackageFile(
  args: InstalledPackageRef,
  relPath: string,
): Promise<ReadResult> {
  const { installedPath } = args;

  const parsed = relPathSchema.safeParse(relPath);

  if (!parsed.success) {
    log.warn(
      { code: parsed.error.issues[0]?.message, relPathLength: relPath.length },
      "package file path-confinement reject",
    );

    return { state: "not-found" };
  }

  const rootResolved = path.resolve(installedPath);
  const lexical = path.resolve(rootResolved, parsed.data);

  if (
    lexical !== rootResolved &&
    !lexical.startsWith(rootResolved + path.sep)
  ) {
    log.warn(
      { code: "lexical_escape", relPathLength: relPath.length },
      "package file path-confinement reject",
    );

    return { state: "not-found" };
  }

  let rootReal: string;

  try {
    rootReal = await realpath(rootResolved);
  } catch (err) {
    if (isEnoent(err)) return { state: "bundle-missing" };
    throw err;
  }

  let real: string;

  try {
    real = await realpath(lexical);
  } catch (err) {
    if (isEnoent(err)) return { state: "not-found" };
    throw err;
  }

  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    log.warn(
      { code: "symlink_escape", relPathLength: relPath.length },
      "package file path-confinement reject",
    );

    return { state: "not-found" };
  }

  const stats = await stat(real);

  // A confined path can still name a DIRECTORY (e.g. `?file=skills`) —
  // readFile would throw EISDIR and 500 the RSC instead of a typed state.
  if (!stats.isFile()) return { state: "not-found" };

  if (stats.size > MAX_FILE_BYTES) return { state: "too-large" };

  const bytes = await readFile(real);

  if (bytes.includes(0)) return { state: "binary" };

  try {
    const content = UTF8_DECODER.decode(bytes);

    return { state: "text", content, kind: classifyPackageFile(parsed.data) };
  } catch {
    return { state: "binary" };
  }
}
