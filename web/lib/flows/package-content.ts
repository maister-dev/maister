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

export type PackageFileEntry = { path: string; kind: string; size: number };

export type ListResult =
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

export type ReadResult = { state: ReadState; content?: string; kind?: string };

// Image preview read (M36 T1.5): a confined image file rendered as a data URI so
// the bytes can show in an <img> without ever exposing the disk path. Non-image
// or oversized → the same typed states as the text reader.
type ImageReadResult =
  | { state: "image"; dataUri: string }
  | { state: "binary" | "too-large" | "not-found" | "bundle-missing" };

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

export function imageMimeForPath(relPath: string): string | null {
  return IMAGE_MIME_BY_EXT[path.extname(relPath).toLowerCase()] ?? null;
}

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

// Real packages nest skills/agents under a capability bundle
// (`<capability>/skills/<id>/`, `<capability>/agents/<stem>.md` — see
// lib/packages/attach.ts collectInventory); the authored/legacy layout puts them
// at the bundle root. These resolvers locate the member's real on-disk location
// from the file listing so the viewer reads either layout. The `skills/<id>/`
// (resp. `agents/<stem>.md`) match is anchored to a path-segment boundary so a
// shorter id never matches a longer sibling. `null` = no file for the member.
export function resolveBundledSkillPrefix(
  files: { path: string }[],
  skillId: string,
): string | null {
  const segment = `skills/${skillId}/`;

  for (const file of files) {
    const idx = file.path.indexOf(segment);

    if (idx === 0 || (idx > 0 && file.path[idx - 1] === "/")) {
      return file.path.slice(0, idx + segment.length);
    }
  }

  return null;
}

export function resolveBundledAgentPath(
  files: { path: string }[],
  stem: string,
): string | null {
  const suffix = `agents/${stem}.md`;

  for (const file of files) {
    if (file.path === suffix || file.path.endsWith(`/${suffix}`)) {
      return file.path;
    }
  }

  return null;
}

type ConfineResult =
  | { ok: true; real: string }
  | { ok: false; state: "not-found" | "too-large" | "bundle-missing" };

// THE single path-confinement gate for per-file reads off an installed package.
// Validates the untrusted rel-path, blocks lexical + symlink escape, rejects a
// directory target, and caps size — returning the real absolute path or a typed
// state. Both the text reader and the image reader go through here; do NOT
// reimplement confinement at a call site.
async function resolveConfinedFile(
  installedPath: string,
  relPath: string,
): Promise<ConfineResult> {
  const parsed = relPathSchema.safeParse(relPath);

  if (!parsed.success) {
    log.warn(
      { code: parsed.error.issues[0]?.message, relPathLength: relPath.length },
      "package file path-confinement reject",
    );

    return { ok: false, state: "not-found" };
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

    return { ok: false, state: "not-found" };
  }

  let rootReal: string;

  try {
    rootReal = await realpath(rootResolved);
  } catch (err) {
    if (isEnoent(err)) return { ok: false, state: "bundle-missing" };
    throw err;
  }

  let real: string;

  try {
    real = await realpath(lexical);
  } catch (err) {
    if (isEnoent(err)) return { ok: false, state: "not-found" };
    throw err;
  }

  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    log.warn(
      { code: "symlink_escape", relPathLength: relPath.length },
      "package file path-confinement reject",
    );

    return { ok: false, state: "not-found" };
  }

  const stats = await stat(real);

  // A confined path can still name a DIRECTORY (e.g. `?file=skills`) —
  // readFile would throw EISDIR and 500 the RSC instead of a typed state.
  if (!stats.isFile()) return { ok: false, state: "not-found" };

  if (stats.size > MAX_FILE_BYTES) return { ok: false, state: "too-large" };

  return { ok: true, real };
}

// Confine a manifest-declared flow directory path to the package root and return
// the real absolute `flow.yaml` path, or null when the entry is missing, is not a
// regular file, exceeds the size cap, or escapes the root. The flow dir path comes
// from a package manifest — validated at install time for an installed package, but
// UNTRUSTED for a local working dir (the editor parses `maister-package.yaml`
// leniently), so every BOM / preview flow load resolves through this gate instead
// of join()-ing the raw path straight into `loadFlowManifest` (ADR-115 confinement
// fix). Reuses the single `resolveConfinedFile` gate, so a lexical/symlink escape
// is logged once at warn here, then degrades the caller's flow to id-only.
export async function resolveConfinedFlowYaml(
  root: string,
  flowDirPath: string,
): Promise<string | null> {
  const rel = path.join(flowDirPath, "flow.yaml");
  const confined = await resolveConfinedFile(root, rel);

  return confined.ok ? confined.real : null;
}

export async function readInstalledPackageFile(
  args: InstalledPackageRef,
  relPath: string,
): Promise<ReadResult> {
  const confined = await resolveConfinedFile(args.installedPath, relPath);

  if (!confined.ok) return { state: confined.state };

  const bytes = await readFile(confined.real);

  if (bytes.includes(0)) return { state: "binary" };

  try {
    const content = UTF8_DECODER.decode(bytes);

    return { state: "text", content, kind: classifyPackageFile(relPath) };
  } catch {
    return { state: "binary" };
  }
}

export async function readInstalledPackageImage(
  args: InstalledPackageRef,
  relPath: string,
): Promise<ImageReadResult> {
  const mime = imageMimeForPath(relPath);

  if (!mime) return { state: "binary" };

  const confined = await resolveConfinedFile(args.installedPath, relPath);

  if (!confined.ok) return { state: confined.state };

  const bytes = await readFile(confined.real);

  return {
    state: "image",
    dataUri: `data:${mime};base64,${bytes.toString("base64")}`,
  };
}
