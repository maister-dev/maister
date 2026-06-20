import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalPackage } from "@/lib/db/schema";

import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import pino from "pino";

import { gitInitWithCommit } from "./git";
import { localPackageWorkingDir, resolveWithinWorkingDir } from "./paths";
import {
  cleanCopyExcludingGit,
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

export type ForkResult = { localPackageId: string };

// (M36 T2.6) Package-level fork: clean-copy ALL of an installed package's
// working files (minus `.git`) into a fresh git-init'd local package named
// `<sourceName>-local`, recording the lineage. Executes NOTHING (no setup.sh,
// no MCP). A missing source bundle → CONFIG, nothing persisted.
export async function forkPackageToLocal(opts: {
  sourceInstallId: string;
  sourceRef: string;
  createdBy: string;
  db?: Db;
}): Promise<ForkResult> {
  const { installedPath } = await loadInstallSource(
    opts.sourceInstallId,
    opts.db,
  );
  const name = `${opts.sourceRef}-local`;
  const slug = await uniqueSlugForName(name, opts.db);
  const workingDir = localPackageWorkingDir(slug);

  log.info(
    { sourceInstallId: opts.sourceInstallId, sourceRef: opts.sourceRef, slug },
    "fork package to local",
  );

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

  const row = inserted[0] as LocalPackage | undefined;

  if (!row) {
    // Roll back the copied scaffold so a failed insert leaves no orphan dir.
    await rm(workingDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw new MaisterError("CONFLICT", "failed to create forked local package");
  }

  return { localPackageId: row.id };
}

// (M36 T2.6) Element-level fork: copy EXACTLY ONE element (a flow dir / skill
// bundle / agent .md / rule file at `elementPath`) from an installed package
// into the caller-project's default ("virtual") local package, created on first
// use (race-safe). `elementPath` is body-controlled → confined inside BOTH the
// source bundle and the destination working dir before any fs copy. Copying the
// rest of the source is forbidden. Executes NOTHING.
export async function forkElementToDefault(opts: {
  projectId: string;
  projectName: string;
  sourceInstallId: string;
  elementPath: string;
  createdBy: string;
  db?: Db;
}): Promise<ForkResult> {
  const { installedPath } = await loadInstallSource(
    opts.sourceInstallId,
    opts.db,
  );

  // Confine the body-controlled element path inside the SOURCE bundle first —
  // an escape/`.git` segment throws PRECONDITION before any package is created.
  const srcAbs = await resolveWithinWorkingDir(installedPath, opts.elementPath);

  let st: Awaited<ReturnType<typeof stat>>;

  try {
    st = await stat(srcAbs);
  } catch {
    throw new MaisterError(
      "PRECONDITION",
      `no such element in source package: ${opts.elementPath}`,
    );
  }

  const pkg = await ensureDefaultLocalPackage({
    projectId: opts.projectId,
    projectName: opts.projectName,
    createdBy: opts.createdBy,
    db: opts.db,
  });
  const destAbs = await resolveWithinWorkingDir(
    pkg.workingDir,
    opts.elementPath,
  );

  log.info(
    {
      projectId: opts.projectId,
      sourceInstallId: opts.sourceInstallId,
      elementPath: opts.elementPath,
      localPackageId: pkg.id,
    },
    "fork element to default local package",
  );

  if (st.isDirectory()) {
    await cleanCopyExcludingGit(srcAbs, destAbs);
  } else {
    await mkdir(path.dirname(destAbs), { recursive: true });
    await cp(srcAbs, destAbs, { force: true });
  }

  return { localPackageId: pkg.id };
}
