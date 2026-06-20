import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalPackage } from "@/lib/db/schema";

import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile as fsReadFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, desc, eq, sql } from "drizzle-orm";
import pino from "pino";

import { gitCommitWorkingDir, gitDiscardPaths, gitInitWithCommit } from "./git";
import {
  localPackageWorkingDir,
  resolveWithinWorkingDir,
  slugifyName,
} from "./paths";

import { atomicWriteText } from "@/lib/atomic";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  prepareDiff,
  prepareDiffSummary,
  type DiffPrepResult,
} from "@/lib/diff/prepare";
import { diffWorkingTree } from "@/lib/worktree";

const log = pino({
  name: "local-packages/service",
  level: process.env.LOG_LEVEL ?? "info",
});

type Db = NodePgDatabase<typeof schema>;

// FIXME(any): dual drizzle peer-dep variants (matches authz.ts). Optional db
// override lets integration tests pass a testcontainer connection.
function resolveDb(db?: Db): Db {
  return db ?? (getDb() as unknown as Db);
}

const lp = schema.localPackages;

const KIND_DIRS = [
  "flows",
  "agents",
  "skills",
  "mcps",
  "rules",
  "schemas",
] as const;
const DEFAULT_BRANCH = "main";

export type LocalPackageFileMeta = { path: string; kind: string };
export type LocalPackageFileContent = LocalPackageFileMeta & {
  content: string;
  contentHash: string;
};

// Inferred artifact kind for a working-dir-relative path (top dir wins).
export function inferFileKind(relPath: string): string {
  const top = relPath.split(/[\\/]/)[0];

  if (relPath === "flow.yaml") return "flow";
  if (relPath === "maister-package.yaml") return "manifest";

  switch (top) {
    case "flows":
      return "flow";
    case "agents":
      return "agent";
    case "skills":
      return "skill";
    case "mcps":
      return "mcp";
    case "rules":
      return "rule";
    case "schemas":
      return "schema";
    default:
      return relPath.endsWith(".md") ? "readme" : "asset";
  }
}

// Exported for the fork path (T2.6): a slug that does not collide with any
// existing local-package slug, suffixed `-2..` then a uuid tail as a last resort.
export async function uniqueSlugForName(
  name: string,
  db?: Db,
): Promise<string> {
  const base = slugifyName(name);
  const existing = await resolveDb(db).select({ slug: lp.slug }).from(lp);
  const taken = new Set(existing.map((r) => r.slug));

  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  return `${base}-${randomUUID().slice(0, 8)}`;
}

async function scaffoldWorkingDir(
  workingDir: string,
  name: string,
): Promise<void> {
  await mkdir(workingDir, { recursive: true });
  for (const d of KIND_DIRS) {
    await mkdir(path.join(workingDir, d), { recursive: true });
  }
  await atomicWriteText(
    path.join(workingDir, "maister-package.yaml"),
    `schemaVersion: 1\nname: ${name}\nflows: []\n`,
  );
}

// Recursively copy `src` into `dest` skipping every VCS `.git` entry, so a fork
// or a cut-version export carries the package CONTENT but not the source repo
// history (the dest is re-git-init'd fresh, or installed content-addressed).
// `cp`'s filter receives absolute paths; we reject any whose basename is `.git`.
export async function cleanCopyExcludingGit(
  src: string,
  dest: string,
): Promise<void> {
  await mkdir(dest, { recursive: true });
  await cp(src, dest, {
    recursive: true,
    errorOnExist: false,
    force: true,
    filter: (source) => path.basename(source) !== ".git",
  });
}

// Clean-export a local package's working dir (minus `.git`) into a fresh tmp
// dir the caller MUST `rm` after use. Used by cut-version to feed an immutable,
// content-addressed install without exposing the working dir to the installer.
export async function exportWorkingDir(pkg: LocalPackage): Promise<string> {
  const exportDir = await mkdtemp(path.join(os.tmpdir(), "maister-lp-export-"));

  await cleanCopyExcludingGit(pkg.workingDir, exportDir);

  return exportDir;
}

export async function createLocalPackage(opts: {
  name: string;
  createdBy: string;
  sourceInstallId?: string | null;
  db?: Db;
}): Promise<LocalPackage> {
  const slug = await uniqueSlugForName(opts.name, opts.db);
  const workingDir = localPackageWorkingDir(slug);

  log.info({ slug, workingDir }, "create local package");
  await scaffoldWorkingDir(workingDir, opts.name);
  await gitInitWithCommit(
    workingDir,
    DEFAULT_BRANCH,
    "maister: init local package",
  );

  const rows = await resolveDb(opts.db)
    .insert(lp)
    .values({
      name: opts.name,
      slug,
      workingDir,
      status: "active",
      branchName: DEFAULT_BRANCH,
      sourceInstallId: opts.sourceInstallId ?? null,
      createdBy: opts.createdBy,
    })
    .returning();

  const row = rows[0];

  if (!row) {
    // Roll back the scaffold so a failed insert leaves no orphan dir.
    await rm(workingDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw new MaisterError("CONFLICT", "failed to create local package");
  }

  return row;
}

export async function listLocalPackages(db?: Db): Promise<LocalPackage[]> {
  return resolveDb(db)
    .select()
    .from(lp)
    .where(eq(lp.status, "active"))
    .orderBy(desc(lp.updatedAt));
}

export async function getLocalPackage(
  id: string,
  db?: Db,
): Promise<LocalPackage | null> {
  const rows = await resolveDb(db).select().from(lp).where(eq(lp.id, id));

  return rows[0] ?? null;
}

export async function getDefaultLocalPackage(
  projectId: string,
  db?: Db,
): Promise<LocalPackage | null> {
  const rows = await resolveDb(db)
    .select()
    .from(lp)
    .where(and(eq(lp.projectId, projectId), eq(lp.isDefault, true)));

  return rows[0] ?? null;
}

// (M36 ADR-096) Resolve-or-create THE per-project default ("virtual") local
// package that element-level forks land in. Race-safe by construction: the
// scaffold + insert race on the partial-unique `(project_id) WHERE is_default`
// index — `onConflictDoNothing` lets the loser fall through to a re-select of
// the winner's row (NEVER a read-then-write SELECT/TOCTOU). The loser's orphan
// scaffold dir is rolled back.
export async function ensureDefaultLocalPackage(opts: {
  projectId: string;
  projectName: string;
  createdBy: string;
  db?: Db;
}): Promise<LocalPackage> {
  const existing = await getDefaultLocalPackage(opts.projectId, opts.db);

  if (existing) return existing;

  const name = `${opts.projectName} (local)`;
  const slug = await uniqueSlugForName(name, opts.db);
  const workingDir = localPackageWorkingDir(slug);

  log.info({ projectId: opts.projectId, slug }, "ensure default local package");
  await scaffoldWorkingDir(workingDir, name);
  await gitInitWithCommit(
    workingDir,
    DEFAULT_BRANCH,
    "maister: init default local package",
  );

  const inserted = await resolveDb(opts.db)
    .insert(lp)
    .values({
      name,
      slug,
      workingDir,
      status: "active",
      branchName: DEFAULT_BRANCH,
      projectId: opts.projectId,
      isDefault: true,
      createdBy: opts.createdBy,
    })
    .onConflictDoNothing({
      target: lp.projectId,
      where: sql`${lp.isDefault}`,
    })
    .returning();

  const row = inserted[0];

  if (row) return row;

  // Lost the race: another concurrent caller created the default first. Roll
  // back this caller's now-orphan scaffold and return the winner's row.
  await rm(workingDir, { recursive: true, force: true }).catch(() => undefined);
  const winner = await getDefaultLocalPackage(opts.projectId, opts.db);

  if (!winner) {
    throw new MaisterError(
      "CONFLICT",
      "failed to ensure default local package",
    );
  }

  return winner;
}

export async function renameLocalPackage(
  id: string,
  name: string,
  db?: Db,
): Promise<LocalPackage | null> {
  const rows = await resolveDb(db)
    .update(lp)
    .set({ name, updatedAt: new Date() })
    .where(eq(lp.id, id))
    .returning();

  return rows[0] ?? null;
}

export async function setLocalPackageStatus(
  id: string,
  status: "active" | "archived",
  db?: Db,
): Promise<LocalPackage | null> {
  const rows = await resolveDb(db)
    .update(lp)
    .set({ status, updatedAt: new Date() })
    .where(eq(lp.id, id))
    .returning();

  return rows[0] ?? null;
}

// (M36 T2.7) Stamp the install a cut-version produced as this package's latest
// cut. The cut install is a content-addressed COPY — later working-dir edits do
// not mutate it (a fresh cut produces a new immutable revision).
export async function stampLastCutInstall(
  id: string,
  installId: string,
  db?: Db,
): Promise<LocalPackage | null> {
  const rows = await resolveDb(db)
    .update(lp)
    .set({ lastCutInstallId: installId, updatedAt: new Date() })
    .where(eq(lp.id, id))
    .returning();

  return rows[0] ?? null;
}

export async function deleteLocalPackage(id: string, db?: Db): Promise<void> {
  const row = await getLocalPackage(id, db);

  if (!row) return;
  await resolveDb(db).delete(lp).where(eq(lp.id, id));
  // Explicit user delete removes the working dir; there is no background GC
  // (owner decision) — orphans from a crash mid-delete are cleaned manually.
  await rm(row.workingDir, { recursive: true, force: true }).catch((err) =>
    log.warn(
      { err, workingDir: row.workingDir },
      "working dir rm failed (left for manual cleanup)",
    ),
  );
  log.info({ id, slug: row.slug }, "deleted local package + working dir");
}

export async function listFiles(
  pkg: LocalPackage,
): Promise<LocalPackageFileMeta[]> {
  let names: string[];

  try {
    names = await readdir(pkg.workingDir, {
      recursive: true,
      encoding: "utf8",
    });
  } catch {
    throw new MaisterError(
      "CONFIG",
      `local-package working dir is missing: ${pkg.workingDir}`,
    );
  }

  const files: LocalPackageFileMeta[] = [];

  for (const name of names) {
    const rel = name.split(path.sep).join("/");

    if (rel.split("/")[0] === ".git") continue;
    const st = await stat(path.join(pkg.workingDir, name)).catch(() => null);

    if (!st || !st.isFile()) continue;
    files.push({ path: rel, kind: inferFileKind(rel) });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return files;
}

export async function readFileContent(
  pkg: LocalPackage,
  relPath: string,
): Promise<LocalPackageFileContent> {
  const abs = await resolveWithinWorkingDir(pkg.workingDir, relPath);
  let content: string;

  try {
    content = await fsReadFile(abs, "utf8");
  } catch {
    throw new MaisterError("PRECONDITION", `no such file: ${relPath}`);
  }

  return {
    path: relPath.split(path.sep).join("/"),
    kind: inferFileKind(relPath),
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

// Confined atomic write of a working-dir file (M36 T2.3). The caller MUST have
// asserted the session edit-lock first; this is the file-system side only.
// `resolveWithinWorkingDir` rejects abs/`..`/`.git`/symlink-escape before any fs.
export async function writeWorkingDirFile(
  pkg: LocalPackage,
  relPath: string,
  content: string,
): Promise<LocalPackageFileContent> {
  const abs = await resolveWithinWorkingDir(pkg.workingDir, relPath);

  await mkdir(path.dirname(abs), { recursive: true });
  await atomicWriteText(abs, content);

  return {
    path: relPath.split(path.sep).join("/"),
    kind: inferFileKind(relPath),
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

// Confined delete of a working-dir file (M36 T2.3). Idempotent (`force`); a
// missing file is not an error. Lock-asserted by the caller.
export async function deleteWorkingDirFile(
  pkg: LocalPackage,
  relPath: string,
): Promise<void> {
  const abs = await resolveWithinWorkingDir(pkg.workingDir, relPath);

  await rm(abs, { force: true });
}

// The git-backed working-tree diff of a local package (M36 T4.1): every
// uncommitted edit (tracked changes + new files) vs the current branch HEAD.
// `changedCount` = the number of changed paths (drives the editor's `⎇ N
// changed` badge).
export type WorkingDirDiff = DiffPrepResult & { changedCount: number };

// HEAD-vs-working-tree (2-dot): `diffWorkingTree` runs `git diff HEAD` against a
// throwaway intent-to-add index, so it captures committed-but-unstaged edits AND
// untracked files WITHOUT touching the real index. This is the uncommitted-work
// diff — NOT a 3-dot merge-base diff — exactly what the editor needs to show and
// commit/discard. `truncated` is threaded end-to-end so a diff cut at the buffer
// bound is flagged, never silently dropped (prepare degrades to summary-only).
export async function diffWorkingDir(
  pkg: LocalPackage,
): Promise<WorkingDirDiff> {
  const wt = await diffWorkingTree(pkg.workingDir);
  const changedCount = wt.nameStatus.length;

  try {
    const prepared = await prepareDiff(wt.text, wt.truncated);

    return { ...prepared, changedCount };
  } catch (err) {
    // git-diff-view preparation (Shiki highlight) failed — degrade to the
    // file-summary projection so the count + truncated flag still surface.
    log.warn(
      {
        slug: pkg.slug,
        err: err instanceof Error ? err.message : String(err),
      },
      "working-dir diff prepare failed — summary only",
    );
    const summary = prepareDiffSummary(wt.text, wt.truncated);

    return {
      files: summary.files,
      perFile: [],
      truncated: summary.truncated,
      changedCount,
    };
  }
}

// Commit every working-tree change to the local-package branch (M36 T4.1). The
// caller MUST have asserted the session edit-lock first; this is the git side
// only.
export async function commitWorkingDir(
  pkg: LocalPackage,
  message?: string,
): Promise<void> {
  await gitCommitWorkingDir(
    pkg.workingDir,
    message?.trim() ? message.trim() : "maister: edit local package",
  );
}

// Discard working-tree edits, restoring to HEAD (M36 T4.1). `paths` (when given)
// are each confined via `resolveWithinWorkingDir` BEFORE git sees them — a
// raw body path never reaches `git checkout`. Omitted → restore the whole tree.
// Lock-asserted by the caller.
export async function discardWorkingDir(
  pkg: LocalPackage,
  paths?: readonly string[],
): Promise<void> {
  if (!paths || paths.length === 0) {
    await gitDiscardPaths(pkg.workingDir);

    return;
  }

  // Confine each path lexically + against the realpath BEFORE git. Pass git the
  // ORIGINAL working-dir-relative path (not the resolved absolute) so it stays a
  // pathspec relative to the repo root.
  for (const relPath of paths) {
    await resolveWithinWorkingDir(pkg.workingDir, relPath);
  }
  await gitDiscardPaths(
    pkg.workingDir,
    paths.map((p) => p.split(path.sep).join("/")),
  );
}

// Client-safe projection: working_dir + locked_by_session are server-only and
// intentionally omitted (D1/D10).
export function toLocalPackageDto(row: LocalPackage) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    sourceInstallId: row.sourceInstallId,
    sourceRepoUrl: row.sourceRepoUrl,
    sourceRef: row.sourceRef,
    branchName: row.branchName,
    lastCutInstallId: row.lastCutInstallId,
    lockedByUserId: row.lockedByUserId,
    lockExpiresAt: row.lockExpiresAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
