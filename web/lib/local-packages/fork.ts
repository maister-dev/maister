import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalPackage } from "@/lib/db/schema";

import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { and, asc, eq } from "drizzle-orm";
import pino from "pino";

import { gitInitWithCommit } from "./git";
import { localPackageWorkingDir, resolveWithinWorkingDir } from "./paths";
import {
  cleanCopyExcludingGit,
  createLocalPackage,
  ensureDefaultLocalPackage,
  uniqueSlugForName,
} from "./service";

import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "local-packages/fork",
  level: process.env.LOG_LEVEL ?? "info",
});

type Db = NodePgDatabase<typeof schema>;

// FIXME(any): dual drizzle peer-dep variants (matches service.ts). Optional db
// override lets integration tests pass a testcontainer connection.
function resolveDb(db?: Db): Db {
  return db ?? (getDb() as unknown as Db);
}

const lp = schema.localPackages;
const { packageInstalls } = schema;
const DEFAULT_BRANCH = "main";

// The installed-package source bundle a fork copies FROM. `installedPath` is
// server-only and is read here ONLY to copy bytes — it never returns to a DTO.
async function loadInstallSource(
  installId: string,
  db?: Db,
): Promise<{ installedPath: string; name: string }> {
  const rows = await resolveDb(db)
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, installId));
  const install = rows[0] as
    | { installedPath?: string; name?: string }
    | undefined;

  if (!install) {
    throw new MaisterError("CONFIG", `package install not found: ${installId}`);
  }

  const installedPath = install.installedPath;

  if (!installedPath) {
    throw new MaisterError(
      "CONFIG",
      `package install ${installId} has no on-disk path`,
    );
  }

  // Reads precede the one write; a missing/unreadable source bundle must throw
  // CONFIG and persist NOTHING (skill-context rule 1).
  try {
    const st = await stat(installedPath);

    if (!st.isDirectory()) throw new Error("not a directory");
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `package install ${installId} source bundle is missing at ${installedPath}: ${(err as Error).message}`,
    );
  }

  return { installedPath, name: install.name ?? "package" };
}

export type ForkResult = { localPackageId: string; alreadyExists?: boolean };

// (M36 T2.6 · M39 A3) Package-level fork: clean-copy ALL of an installed
// package's working files (minus `.git`) into a fresh git-init'd local package
// named `<sourceName>-local`, recording the lineage. Executes NOTHING (no
// setup.sh, no MCP). A missing source bundle → CONFIG, nothing persisted.
//
// Fork DEDUP (A3, owner): packages are centralized, so a second fork of the same
// `source_install_id` returns the EXISTING active fork (`alreadyExists: true`,
// HTTP 200) instead of a duplicate — unless `forceNew` ("Fork a new copy" /
// "Customize for this project"). No DB uniqueness constraint exists (Stream A is
// migration-free), so two truly-concurrent first forks of one install can still
// each create a copy; that is rare, non-destructive (an extra deletable
// package), and acceptable for the click-twice case this guards.
export async function forkPackageToLocal(opts: {
  sourceInstallId: string;
  sourceRef: string;
  createdBy: string;
  forceNew?: boolean;
  // Override the fork's display name. "Customize" uses `<ref> (custom)` to mark a
  // deliberate divergent copy (always paired with forceNew); the default fork is
  // `<ref>-local`.
  name?: string;
  db?: Db;
}): Promise<ForkResult> {
  if (!opts.forceNew) {
    const existing = await resolveDb(opts.db)
      .select({ id: lp.id })
      .from(lp)
      .where(
        and(
          eq(lp.sourceInstallId, opts.sourceInstallId),
          eq(lp.status, "active"),
        ),
      )
      // Oldest active fork wins — deterministic + intuitive ("your fork") when
      // an explicit forceNew copy has produced more than one.
      .orderBy(asc(lp.createdAt))
      .limit(1);
    const found = existing[0];

    if (found) {
      log.info(
        { sourceInstallId: opts.sourceInstallId, localPackageId: found.id },
        "fork dedup — returning existing fork",
      );

      return { localPackageId: found.id, alreadyExists: true };
    }
  }

  const { installedPath } = await loadInstallSource(
    opts.sourceInstallId,
    opts.db,
  );
  const name = opts.name ?? `${opts.sourceRef}-local`;
  const slug = await uniqueSlugForName(name, opts.db);
  const workingDir = localPackageWorkingDir(slug);

  log.info(
    { sourceInstallId: opts.sourceInstallId, sourceRef: opts.sourceRef, slug },
    "fork package to local",
  );

  let row: LocalPackage | undefined;

  try {
    await cleanCopyExcludingGit(installedPath, workingDir);
    await gitInitWithCommit(
      workingDir,
      DEFAULT_BRANCH,
      `maister: fork ${opts.sourceRef} to local package`,
    );

    const inserted = await resolveDb(opts.db)
      .insert(lp)
      .values({
        name,
        slug,
        workingDir,
        status: "active",
        branchName: DEFAULT_BRANCH,
        sourceInstallId: opts.sourceInstallId,
        sourceRef: opts.sourceRef,
        createdBy: opts.createdBy,
      })
      .returning();

    row = inserted[0] as LocalPackage | undefined;
  } catch (err) {
    // Any failure AFTER the dir exists (copy / git-init / insert) rolls back the
    // scaffold so a failed fork leaves no orphan working dir.
    await rm(workingDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw err;
  }

  if (!row) {
    await rm(workingDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw new MaisterError("CONFLICT", "failed to create forked local package");
  }

  return { localPackageId: row.id, alreadyExists: false };
}

// Resolve + confine + stat ONE element inside an installed package's SOURCE
// bundle BEFORE any local package is created — a body-controlled `elementPath`
// that escapes (`..`/`.git`/abs/symlink) throws PRECONDITION, and a missing
// element/bundle throws PRECONDITION/CONFIG, so a failed element-fork persists
// NOTHING. Shared by both element-fork entry points.
async function loadSourceElement(opts: {
  sourceInstallId: string;
  elementPath: string;
  db?: Db;
}): Promise<{ srcAbs: string; isDirectory: boolean }> {
  const { installedPath } = await loadInstallSource(
    opts.sourceInstallId,
    opts.db,
  );
  const srcAbs = await resolveWithinWorkingDir(installedPath, opts.elementPath);

  try {
    const st = await stat(srcAbs);

    return { srcAbs, isDirectory: st.isDirectory() };
  } catch {
    throw new MaisterError(
      "PRECONDITION",
      `no such element in source package: ${opts.elementPath}`,
    );
  }
}

// Copy ONE confined element into a destination package's working dir. `dest` is
// re-confined inside the working dir before any fs write; copying the rest of
// the source is forbidden — only `elementPath` is written.
async function copyElementInto(
  pkg: LocalPackage,
  elementPath: string,
  src: { srcAbs: string; isDirectory: boolean },
): Promise<void> {
  const destAbs = await resolveWithinWorkingDir(pkg.workingDir, elementPath);

  if (src.isDirectory) {
    await cleanCopyExcludingGit(src.srcAbs, destAbs);
  } else {
    await mkdir(path.dirname(destAbs), { recursive: true });
    await cp(src.srcAbs, destAbs, { force: true });
  }
}

// (M36 T2.6) Element-level fork into the caller-project's default ("virtual")
// local package, created on first use (race-safe). Copies EXACTLY ONE element (a
// flow dir / skill bundle / agent `.md` / rule file at `elementPath`). Executes
// NOTHING. Retained for Stream B — the centralized model uses
// `forkElementToNewLocal`.
export async function forkElementToDefault(opts: {
  projectId: string;
  projectName: string;
  sourceInstallId: string;
  elementPath: string;
  createdBy: string;
  db?: Db;
}): Promise<ForkResult> {
  const src = await loadSourceElement(opts);
  const pkg = await ensureDefaultLocalPackage({
    projectId: opts.projectId,
    projectName: opts.projectName,
    createdBy: opts.createdBy,
    db: opts.db,
  });

  log.info(
    {
      projectId: opts.projectId,
      sourceInstallId: opts.sourceInstallId,
      elementPath: opts.elementPath,
      localPackageId: pkg.id,
    },
    "fork element to default local package",
  );
  await copyElementInto(pkg, opts.elementPath, src);

  return { localPackageId: pkg.id };
}

// (M39 A3) Element-level fork into a NEW centralized local package (the owner's
// centralized model — NO project target). Copies EXACTLY ONE element into a
// freshly-created standalone package named `<elementName> (local)`; the editor
// then opens on it. The new package carries NO `source_install_id` lineage — it
// is a PARTIAL copy, so whole-package fork dedup must never conflate it with a
// full editable fork. Executes NOTHING.
export async function forkElementToNewLocal(opts: {
  sourceInstallId: string;
  elementPath: string;
  elementName: string;
  createdBy: string;
  db?: Db;
}): Promise<ForkResult> {
  const src = await loadSourceElement(opts);
  const pkg = await createLocalPackage({
    name: `${opts.elementName} (local)`,
    createdBy: opts.createdBy,
    db: opts.db,
  });

  log.info(
    {
      sourceInstallId: opts.sourceInstallId,
      elementPath: opts.elementPath,
      localPackageId: pkg.id,
    },
    "fork element to new local package",
  );
  await copyElementInto(pkg, opts.elementPath, src);

  return { localPackageId: pkg.id, alreadyExists: false };
}
