import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalPackage } from "@/lib/db/schema";

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile as fsReadFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { desc, eq } from "drizzle-orm";
import pino from "pino";

import { gitInitWithCommit } from "./git";
import {
  localPackageWorkingDir,
  resolveWithinWorkingDir,
  slugifyName,
} from "./paths";

import { atomicWriteText } from "@/lib/atomic";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

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

async function uniqueSlug(name: string, db?: Db): Promise<string> {
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

export async function createLocalPackage(opts: {
  name: string;
  createdBy: string;
  sourceInstallId?: string | null;
  db?: Db;
}): Promise<LocalPackage> {
  const slug = await uniqueSlug(opts.name, opts.db);
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
