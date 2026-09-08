import "server-only";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LocalPackage, LocalPackageCreationState } from "@/lib/db/schema";

import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile as fsReadFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import pino from "pino";
import { stringify as stringifyYaml } from "yaml";

import {
  ensureLocalPackageGitExclude,
  gitCommitWorkingDir,
  gitDiscardPaths,
  gitHeadSha,
  gitInitWithCommit,
} from "./git";
import {
  appendManifestFlow,
  parsePackageManifest,
  serializeScaffoldManifest,
  validatePackageManifestYaml,
} from "./manifest";
import {
  acquireWorkingDirLock,
  assertHoldsLock,
  releaseWorkingDirLock,
} from "./lock";
import {
  readCreationJournal,
  removeCreationJournal,
  writeCreationJournal,
} from "./create-flow-operation";
import {
  isLocalPackageInternalEntryName,
  isLocalPackageInternalPath,
  localPackageCreationStagingDir,
  localPackageWorkingDir,
  resolveWithinWorkingDir,
  slugifyName,
} from "./paths";
import { validatePackageArtifacts, type PackageArtifactFile } from "./validate";

import { atomicWriteText } from "@/lib/atomic";
import { loadFlowManifest } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  buildStarterFlowManifest,
  type CreateFlowInput,
} from "@/lib/local-packages/create-flow-contract";
import { classifyPackageFilePath } from "@/lib/flows/editor/package-file-tree";
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
const TERMINAL_LOCAL_ASSISTANT_RUN_STATUSES = new Set([
  "Done",
  "Failed",
  "Abandoned",
]);

const KIND_DIRS = [
  "flows",
  "agents",
  "skills",
  "mcps",
  "rules",
  "schemas",
] as const;
const DEFAULT_BRANCH = "main";

export type LocalPackageFileMeta = {
  path: string;
  // SSOT: the one client-safe classifier shared with the package-files editor +
  // commit gate (ADR-105 first-class kinds incl. `subagent`/`agent_definition`).
  kind: ReturnType<typeof classifyPackageFilePath>;
};
export type LocalPackageFileContent = LocalPackageFileMeta & {
  content: string;
  contentHash: string;
};

export type LocalPackageSourceInstall = {
  id: string;
  name: string;
  versionLabel: string;
};

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

// Claim filesystem ownership before any package artifact is written. A database
// row owns an identity, not a path: an existing path must remain untouched.
export async function claimLocalPackageWorkingDir(
  workingDir: string,
): Promise<void> {
  await mkdir(path.dirname(workingDir), { recursive: true });

  try {
    await mkdir(workingDir);
  } catch (err) {
    if (isEexist(err)) {
      throw new MaisterError(
        "CONFLICT",
        "a local package working directory is already in use",
      );
    }
    throw err;
  }
}

// Call only after claimLocalPackageWorkingDir succeeds in this same operation.
export async function removeOwnedLocalPackageWorkingDir(
  workingDir: string,
): Promise<void> {
  await rm(workingDir, { recursive: true, force: true });
}

async function claimInitialCreationStagingDir(
  stagingDir: string,
): Promise<void> {
  await mkdir(path.dirname(stagingDir), { recursive: true });

  try {
    await mkdir(stagingDir);
  } catch (err) {
    if (isEexist(err)) {
      throw new MaisterError(
        "CONFLICT",
        "a private local-package creation stage is already in use",
      );
    }
    throw err;
  }
}

async function scaffoldWorkingDir(
  workingDir: string,
  manifestName: string,
  title: string,
): Promise<void> {
  for (const d of KIND_DIRS) {
    await mkdir(path.join(workingDir, d), { recursive: true });
  }
  await atomicWriteText(
    path.join(workingDir, "maister-package.yaml"),
    serializeScaffoldManifest(manifestName, title),
  );
}

const PACKAGE_MANIFEST_PATH = "maister-package.yaml";

type CanonicalFlowArtifacts = {
  flowPath: string;
  flowYaml: string;
  manifestYaml: string;
};

function textHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function flowYamlPath(flowId: string): string {
  return `flows/${flowId}/flow.yaml`;
}

function flowDirPath(flowId: string): string {
  return `flows/${flowId}`;
}

function createFlowArtifacts(
  manifestYaml: string,
  flow: CreateFlowInput,
): CanonicalFlowArtifacts {
  const parsed = parsePackageManifest(manifestYaml);

  if (!parsed.ok) {
    throw new MaisterError(
      "PRECONDITION",
      "maister-package.yaml is invalid; fix it before adding a Flow",
    );
  }

  if (parsed.model.flows.some((entry) => entry.id === flow.id)) {
    throw new MaisterError(
      "CONFLICT",
      `Flow ID "${flow.id}" already belongs to this package`,
      { details: { reason: "duplicate_flow_id" } },
    );
  }

  const nextManifest = appendManifestFlow(parsed.raw, {
    id: flow.id,
    path: flowDirPath(flow.id),
  });
  const manifestIssues = validatePackageManifestYaml(nextManifest);

  if (manifestIssues.length > 0) {
    throw new MaisterError(
      "PRECONDITION",
      "maister-package.yaml is not valid after adding this Flow",
      { details: { invalidArtifacts: manifestIssues } },
    );
  }

  return {
    flowPath: flowYamlPath(flow.id),
    flowYaml: stringifyYaml(buildStarterFlowManifest(flow)),
    manifestYaml: nextManifest,
  };
}

function assertProposedFlowArtifactsValid(
  existingFiles: readonly PackageArtifactFile[],
  artifacts: CanonicalFlowArtifacts,
): void {
  const changedPaths = [PACKAGE_MANIFEST_PATH, artifacts.flowPath];
  const changed = new Set(changedPaths);
  const proposedFiles = [
    ...existingFiles.filter((file) => !changed.has(file.path)),
    { path: PACKAGE_MANIFEST_PATH, content: artifacts.manifestYaml },
    { path: artifacts.flowPath, content: artifacts.flowYaml },
  ];
  const errors = validatePackageArtifacts({
    files: proposedFiles,
    changedPaths,
  });

  if (errors.length > 0) {
    throw new MaisterError(
      "PRECONDITION",
      "the initial Flow does not produce a valid package",
      { details: { invalidArtifacts: errors } },
    );
  }
}

async function readTextIfPresent(filePath: string): Promise<string | null> {
  try {
    return await fsReadFile(filePath, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);

    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

function creationRecoveryStatus(
  row: LocalPackage,
): "ready" | "recovering" | "recovery_required" {
  if (!row.creationState) return "ready";

  return row.creationState.phase === "recovery_required"
    ? "recovery_required"
    : "recovering";
}

function creationConflict(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "this package has an incomplete Flow creation operation — recover it before editing",
    { details: { reason: "creation_recovery_required" } },
  );
}

export function assertLocalPackageCreationReady(pkg: LocalPackage): void {
  if (pkg.creationState) throw creationConflict();
}

async function updateCreationState(
  packageId: string,
  state: LocalPackageCreationState,
  db?: Db,
): Promise<void> {
  await resolveDb(db)
    .update(lp)
    .set({ creationState: state, updatedAt: new Date() })
    .where(eq(lp.id, packageId));
}

async function updateCreationPhase(
  packageId: string,
  state: LocalPackageCreationState,
  phase: LocalPackageCreationState["phase"],
  db?: Db,
): Promise<LocalPackageCreationState> {
  const next = { ...state, phase };

  await updateCreationState(packageId, next, db);

  return next;
}

async function clearCreationState(packageId: string, db?: Db): Promise<void> {
  await resolveDb(db)
    .update(lp)
    .set({ creationState: null, updatedAt: new Date() })
    .where(eq(lp.id, packageId));
}

async function markCreationRecoveryRequired(
  packageId: string,
  state: LocalPackageCreationState,
  db?: Db,
): Promise<void> {
  await updateCreationPhase(packageId, state, "recovery_required", db);
}

async function claimCreationState(
  packageId: string,
  state: LocalPackageCreationState,
  db?: Db,
): Promise<void> {
  const rows = await resolveDb(db)
    .update(lp)
    .set({ creationState: state, updatedAt: new Date() })
    .where(and(eq(lp.id, packageId), isNull(lp.creationState)))
    .returning({ id: lp.id });

  if (rows.length === 0) throw creationConflict();
}

function newCreationState(opts: {
  kind: LocalPackageCreationState["kind"];
  flowId: string;
  manifestYaml: string;
  flowYaml: string;
  originalManifestHash?: string;
}): LocalPackageCreationState {
  return {
    operationId: randomUUID(),
    kind: opts.kind,
    phase: "claimed",
    flowId: opts.flowId,
    manifestHash: textHash(opts.manifestYaml),
    flowHash: textHash(opts.flowYaml),
    ...(opts.originalManifestHash
      ? { originalManifestHash: opts.originalManifestHash }
      : {}),
    startedAt: new Date().toISOString(),
  };
}

function assertExpectedArtifacts(
  state: LocalPackageCreationState,
  artifacts: CanonicalFlowArtifacts,
): void {
  if (
    textHash(artifacts.manifestYaml) !== state.manifestHash ||
    textHash(artifacts.flowYaml) !== state.flowHash
  ) {
    throw new MaisterError(
      "CONFIG",
      "the pending Flow creation journal does not match its expected artifacts",
    );
  }
}

async function materializeInitialFlow(
  pkg: LocalPackage,
  state: LocalPackageCreationState,
  db?: Db,
): Promise<void> {
  const [currentManifest, currentFlow] = await Promise.all([
    readTextIfPresent(path.join(pkg.workingDir, PACKAGE_MANIFEST_PATH)),
    readTextIfPresent(path.join(pkg.workingDir, flowYamlPath(state.flowId))),
  ]);
  const finalArtifactsMatch =
    currentManifest !== null &&
    currentFlow !== null &&
    textHash(currentManifest) === state.manifestHash &&
    textHash(currentFlow) === state.flowHash;

  // `rename(stage, workingDir)` is atomic. A crash after that rename but before
  // deleting the journal/DB marker has already produced the exact package; do
  // not replay it or strand it merely because the staging directory is gone.
  if (finalArtifactsMatch) {
    const hasHead = await gitHeadSha(pkg.workingDir)
      .then(() => true)
      .catch(() => false);

    if (hasHead) {
      await removeCreationJournal(pkg.workingDir, state.operationId);
      await clearCreationState(pkg.id, db);

      return;
    }
  }

  const stagingDir = localPackageCreationStagingDir(
    pkg.workingDir,
    state.operationId,
  );
  const journal = await readCreationJournal(stagingDir, state.operationId);

  if (!journal) {
    await markCreationRecoveryRequired(pkg.id, state, db);
    throw creationConflict();
  }
  if (journal.flow.id !== state.flowId) {
    await markCreationRecoveryRequired(pkg.id, state, db);
    throw creationConflict();
  }

  const seedManifest = serializeScaffoldManifest(pkg.slug, pkg.name);
  const artifacts = createFlowArtifacts(seedManifest, journal.flow);

  assertExpectedArtifacts(state, artifacts);

  const manifestAbs = path.join(stagingDir, PACKAGE_MANIFEST_PATH);
  const flowAbs = path.join(stagingDir, artifacts.flowPath);
  const [stagedManifest, stagedFlow] = await Promise.all([
    readTextIfPresent(manifestAbs),
    readTextIfPresent(flowAbs),
  ]);
  const manifestMatches = stagedManifest === artifacts.manifestYaml;
  const flowMatches = stagedFlow === artifacts.flowYaml;

  if (!manifestMatches || !flowMatches) {
    const mayMaterialize =
      (stagedManifest === null || manifestMatches) &&
      (stagedFlow === null || flowMatches);

    if (!mayMaterialize) {
      await markCreationRecoveryRequired(pkg.id, state, db);
      throw creationConflict();
    }

    await mkdir(path.dirname(flowAbs), { recursive: true });
    if (!flowMatches) await atomicWriteText(flowAbs, artifacts.flowYaml);
    if (!manifestMatches) {
      await atomicWriteText(manifestAbs, artifacts.manifestYaml);
    }
    state = await updateCreationPhase(pkg.id, state, "scaffolded", db);
  }

  const hasHead = await gitHeadSha(stagingDir)
    .then(() => true)
    .catch(() => false);

  if (!hasHead) {
    await gitInitWithCommit(
      stagingDir,
      DEFAULT_BRANCH,
      "maister: initialize local package with Flow",
    );
  }

  await updateCreationPhase(pkg.id, state, "git_initialized", db);
  await rename(stagingDir, pkg.workingDir);
  await removeCreationJournal(pkg.workingDir, state.operationId);
  await clearCreationState(pkg.id, db);
}

async function materializeAdditionalFlow(
  pkg: LocalPackage,
  state: LocalPackageCreationState,
  db?: Db,
): Promise<void> {
  const journal = await readCreationJournal(pkg.workingDir, state.operationId);
  const originalManifest = journal?.originalManifest;

  if (!originalManifest || !state.originalManifestHash) {
    const [currentManifest, currentFlow] = await Promise.all([
      readTextIfPresent(path.join(pkg.workingDir, PACKAGE_MANIFEST_PATH)),
      readTextIfPresent(path.join(pkg.workingDir, flowYamlPath(state.flowId))),
    ]);

    if (
      currentManifest !== null &&
      currentFlow !== null &&
      textHash(currentManifest) === state.manifestHash &&
      textHash(currentFlow) === state.flowHash
    ) {
      await clearCreationState(pkg.id, db);

      return;
    }

    await markCreationRecoveryRequired(pkg.id, state, db);
    throw creationConflict();
  }
  if (journal.flow.id !== state.flowId) {
    await markCreationRecoveryRequired(pkg.id, state, db);
    throw creationConflict();
  }

  const artifacts = createFlowArtifacts(originalManifest, journal.flow);

  assertExpectedArtifacts(state, artifacts);
  if (textHash(originalManifest) !== state.originalManifestHash) {
    await markCreationRecoveryRequired(pkg.id, state, db);
    throw creationConflict();
  }

  const manifestAbs = path.join(pkg.workingDir, PACKAGE_MANIFEST_PATH);
  const flowAbs = path.join(pkg.workingDir, artifacts.flowPath);
  const [currentManifest, currentFlow] = await Promise.all([
    readTextIfPresent(manifestAbs),
    readTextIfPresent(flowAbs),
  ]);
  const manifestMatches = currentManifest === artifacts.manifestYaml;
  const flowMatches = currentFlow === artifacts.flowYaml;
  const manifestAtBaseline = currentManifest === originalManifest;

  if (!manifestMatches || !flowMatches) {
    const mayMaterialize =
      (manifestAtBaseline || manifestMatches) &&
      (currentFlow === null || flowMatches);

    if (!mayMaterialize) {
      await markCreationRecoveryRequired(pkg.id, state, db);
      throw creationConflict();
    }

    await mkdir(path.dirname(flowAbs), { recursive: true });
    if (!flowMatches) await atomicWriteText(flowAbs, artifacts.flowYaml);
    if (!manifestMatches) {
      await atomicWriteText(manifestAbs, artifacts.manifestYaml);
    }
    state = await updateCreationPhase(pkg.id, state, "scaffolded", db);
  }

  await removeCreationJournal(pkg.workingDir, state.operationId);
  await clearCreationState(pkg.id, db);
}

async function materializeCreation(
  pkg: LocalPackage,
  state: LocalPackageCreationState,
  db?: Db,
): Promise<void> {
  if (state.kind === "create_package_with_flow") {
    await materializeInitialFlow(pkg, state, db);

    return;
  }

  await materializeAdditionalFlow(pkg, state, db);
}

async function compensateFailedInitialCreation(
  pkg: LocalPackage,
  state: LocalPackageCreationState,
  stagingDir: string,
  db?: Db,
): Promise<void> {
  try {
    await rm(stagingDir, { recursive: true, force: true });
  } catch (err) {
    await markCreationRecoveryRequired(pkg.id, state, db);
    log.error(
      { packageId: pkg.id, operationId: state.operationId },
      "initial Flow creation cleanup could not remove the private stage",
    );
    throw err;
  }

  try {
    await resolveDb(db).delete(lp).where(eq(lp.id, pkg.id));
  } catch (err) {
    await markCreationRecoveryRequired(pkg.id, state, db);
    log.error(
      { packageId: pkg.id, operationId: state.operationId },
      "initial Flow creation cleanup could not remove the package row",
    );
    throw err;
  }
}

async function compensateUnjournaledInitialCreation(
  pkg: LocalPackage,
  state: LocalPackageCreationState,
  db?: Db,
): Promise<void> {
  const stagingDir = localPackageCreationStagingDir(
    pkg.workingDir,
    state.operationId,
  );

  await rm(stagingDir, { recursive: true, force: true });
  await rollbackLocalPackageRow(pkg.id, db);
  log.info(
    { packageId: pkg.id, flowId: state.flowId, operationId: state.operationId },
    "[FIX:create-flow-recovery] compensated an unjournaled initial Flow creation",
  );
}

async function compensateFailedAdditionalFlow(
  pkg: LocalPackage,
  state: LocalPackageCreationState,
  fallbackOriginalManifest?: string,
  db?: Db,
): Promise<void> {
  const journal = await readCreationJournal(pkg.workingDir, state.operationId);
  const originalManifest =
    journal?.originalManifest ?? fallbackOriginalManifest;

  if (!originalManifest) {
    await markCreationRecoveryRequired(pkg.id, state, db);
    throw creationConflict();
  }

  try {
    await atomicWriteText(
      path.join(pkg.workingDir, PACKAGE_MANIFEST_PATH),
      originalManifest,
    );
    await rm(path.join(pkg.workingDir, flowDirPath(state.flowId)), {
      recursive: true,
      force: true,
    });
    await removeCreationJournal(pkg.workingDir, state.operationId);
    await clearCreationState(pkg.id, db);
  } catch (err) {
    await markCreationRecoveryRequired(pkg.id, state, db);
    log.error(
      {
        packageId: pkg.id,
        operationId: state.operationId,
        flowId: state.flowId,
      },
      "additional Flow creation compensation failed",
    );
    throw err;
  }
}

// pg unique-violation → CONFLICT (mirrors lib/users.ts + lib/project-members.ts).
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23505"
  );
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isEexist(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}

// Insert-first (ADR-105 D1): claim the unique `slug` in the DB BEFORE any
// filesystem work, so a concurrent same-slug create loses HERE (23505 → CONFLICT)
// having touched nothing on disk — the winner's dir can never be deleted by the
// loser's rollback. Shared by create + fork.
export async function insertLocalPackageRow(
  values: typeof lp.$inferInsert,
  db?: Db,
): Promise<LocalPackage> {
  let rows: LocalPackage[];

  try {
    rows = await resolveDb(db).insert(lp).values(values).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MaisterError(
        "CONFLICT",
        `a local package named "${values.name}" is already being created`,
      );
    }
    throw err;
  }

  const row = rows[0];

  if (!row) {
    throw new MaisterError("CONFLICT", "failed to create local package");
  }

  return row;
}

// Roll back the DB identity after a post-insert failure. Filesystem cleanup is
// deliberately separate and only callers that claimed the directory may remove it.
export async function rollbackLocalPackageRow(
  id: string,
  db?: Db,
): Promise<void> {
  await resolveDb(db).delete(lp).where(eq(lp.id, id));
}

// Recursively copy `src` into `dest` skipping internal working-dir metadata, so
// a fork or a cut-version export carries the package CONTENT but not source repo
// history or MAIster runtime state (the dest is re-git-init'd fresh, or
// installed content-addressed). `cp`'s filter receives absolute paths; we reject
// any internal basename AND any symlink — `cp` copies symlinks verbatim, so an
// escaping symlink in the working dir would otherwise be carried into the
// fork/export and later followed out of confinement.
export async function cleanCopyExcludingGit(
  src: string,
  dest: string,
): Promise<void> {
  await mkdir(dest, { recursive: true });
  await cp(src, dest, {
    recursive: true,
    errorOnExist: false,
    force: true,
    filter: async (source) =>
      !isLocalPackageInternalEntryName(path.basename(source)) &&
      !(await lstat(source)).isSymbolicLink(),
  });
}

// Clean-export a local package's working dir (minus `.git`) into a fresh tmp
// dir the caller MUST `rm` after use. Used by cut-version to feed an immutable,
// content-addressed install without exposing the working dir to the installer.
export async function exportWorkingDir(pkg: LocalPackage): Promise<string> {
  assertLocalPackageCreationReady(pkg);
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

  log.info({ packageSlug: slug }, "create local package");

  // Insert-first: claim the slug before any fs work (see insertLocalPackageRow).
  const row = await insertLocalPackageRow(
    {
      name: opts.name,
      slug,
      workingDir,
      status: "active",
      branchName: DEFAULT_BRANCH,
      sourceInstallId: opts.sourceInstallId ?? null,
      createdBy: opts.createdBy,
    },
    opts.db,
  );

  // Row claimed — now take exclusive filesystem ownership before scaffolding.
  let ownsWorkingDir = false;

  try {
    await claimLocalPackageWorkingDir(workingDir);
    ownsWorkingDir = true;
    await scaffoldWorkingDir(workingDir, slug, opts.name);
    await gitInitWithCommit(
      workingDir,
      DEFAULT_BRANCH,
      "maister: init local package",
    );
  } catch (err) {
    try {
      if (ownsWorkingDir) {
        await removeOwnedLocalPackageWorkingDir(workingDir);
      }
      await rollbackLocalPackageRow(row.id, opts.db);
    } catch (compensationErr) {
      log.error({ packageId: row.id }, "local package creation cleanup failed");
      throw new MaisterError(
        "CRASH",
        "creating the local package failed and cleanup requires recovery",
        { cause: compensationErr, details: { packageId: row.id } },
      );
    }
    throw err;
  }

  return row;
}

// Canonical Studio create: unlike the legacy generic scaffold, this persists a
// first valid Flow in the same operation and makes the initial git commit only
// after both package artifacts are present. No setup script, hook, or package
// code is discovered or executed here.
export async function createLocalPackageWithFlow(opts: {
  name: string;
  createdBy: string;
  flow: CreateFlowInput;
  db?: Db;
}): Promise<{ package: LocalPackage; flowPath: string }> {
  const slug = await uniqueSlugForName(opts.name, opts.db);
  const workingDir = localPackageWorkingDir(slug);
  const seedManifest = serializeScaffoldManifest(slug, opts.name);
  const artifacts = createFlowArtifacts(seedManifest, opts.flow);

  assertProposedFlowArtifactsValid([], artifacts);
  const state = newCreationState({
    kind: "create_package_with_flow",
    flowId: opts.flow.id,
    manifestYaml: artifacts.manifestYaml,
    flowYaml: artifacts.flowYaml,
  });

  log.info(
    { flowId: opts.flow.id, operationId: state.operationId },
    "create local package with first Flow",
  );

  const row = await insertLocalPackageRow(
    {
      name: opts.name,
      slug,
      workingDir,
      status: "active",
      branchName: DEFAULT_BRANCH,
      createdBy: opts.createdBy,
      creationState: state,
    },
    opts.db,
  );
  const lockToken = await acquireWorkingDirLock(row.id, opts.db);
  const stagingDir = localPackageCreationStagingDir(
    row.workingDir,
    state.operationId,
  );
  let ownsStagingDir = false;

  try {
    await claimInitialCreationStagingDir(stagingDir);
    ownsStagingDir = true;
    await writeCreationJournal(stagingDir, state.operationId, {
      flow: opts.flow,
    });
    log.info(
      {
        packageId: row.id,
        flowId: opts.flow.id,
        operationId: state.operationId,
      },
      "initial Flow creation stage ready",
    );
    await materializeCreation(row, state, opts.db);
  } catch (err) {
    const current = await getLocalPackage(row.id, opts.db);

    if (current?.creationState?.phase !== "recovery_required") {
      try {
        if (ownsStagingDir) {
          await compensateFailedInitialCreation(
            row,
            state,
            stagingDir,
            opts.db,
          );
        } else {
          log.warn(
            { packageId: row.id, operationId: state.operationId },
            "creation rollback preserved a private stage this operation did not own",
          );
          await rollbackLocalPackageRow(row.id, opts.db);
        }
      } catch (compensationErr) {
        throw new MaisterError(
          "CRASH",
          "creating the local package failed and cleanup requires recovery",
          {
            cause: compensationErr,
            details: { packageId: row.id, operationId: state.operationId },
          },
        );
      }
    }

    throw err;
  } finally {
    await releaseWorkingDirLock(row.id, lockToken, opts.db);
  }

  const created = await getLocalPackage(row.id, opts.db);

  if (!created) {
    throw new MaisterError(
      "CRASH",
      "the local package disappeared after its first Flow was created",
      { details: { packageId: row.id, operationId: state.operationId } },
    );
  }

  return { package: created, flowPath: artifacts.flowPath };
}

// Canonical "Add Flow" operation for an existing editable package. It takes
// the editor session token only to enforce the existing edit lock; the package
// identity itself is always resolved from the route-owned package id.
export async function addFlowToLocalPackage(opts: {
  packageId: string;
  sessionId: string;
  flow: CreateFlowInput;
  db?: Db;
}): Promise<{ package: LocalPackage; flowPath: string }> {
  await assertHoldsLock(opts.packageId, opts.sessionId, opts.db);
  const lockToken = await acquireWorkingDirLock(opts.packageId, opts.db);

  try {
    await assertHoldsLock(opts.packageId, opts.sessionId, opts.db);
    const pkg = await getLocalPackage(opts.packageId, opts.db);

    if (!pkg || pkg.status !== "active") {
      throw new MaisterError("PRECONDITION", "local package not found");
    }
    assertLocalPackageCreationReady(pkg);
    await assertNoLiveLocalPackageAssistants(pkg.id, resolveDb(opts.db));

    const manifestPath = path.join(pkg.workingDir, PACKAGE_MANIFEST_PATH);
    const currentManifest = await readTextIfPresent(manifestPath);

    if (currentManifest === null) {
      throw new MaisterError(
        "PRECONDITION",
        "maister-package.yaml is missing; recover the package before adding a Flow",
      );
    }

    const existingFlow = await readTextIfPresent(
      path.join(pkg.workingDir, flowYamlPath(opts.flow.id)),
    );

    if (existingFlow !== null) {
      throw new MaisterError(
        "CONFLICT",
        `Flow ID "${opts.flow.id}" already exists in this package`,
        { details: { reason: "duplicate_flow_id" } },
      );
    }

    const artifacts = createFlowArtifacts(currentManifest, opts.flow);
    const existingFiles = await readWorkingDirArtifactFiles(pkg);

    assertProposedFlowArtifactsValid(existingFiles, artifacts);
    const state = newCreationState({
      kind: "add_flow",
      flowId: opts.flow.id,
      manifestYaml: artifacts.manifestYaml,
      flowYaml: artifacts.flowYaml,
      originalManifestHash: textHash(currentManifest),
    });

    await claimCreationState(pkg.id, state, opts.db);
    log.info(
      {
        packageId: pkg.id,
        flowId: opts.flow.id,
        operationId: state.operationId,
      },
      "add Flow to local package",
    );

    try {
      await writeCreationJournal(pkg.workingDir, state.operationId, {
        flow: opts.flow,
        originalManifest: currentManifest,
      });
      await materializeCreation(pkg, state, opts.db);
    } catch (err) {
      const current = await getLocalPackage(pkg.id, opts.db);

      if (current?.creationState?.phase !== "recovery_required") {
        try {
          await compensateFailedAdditionalFlow(
            pkg,
            state,
            currentManifest,
            opts.db,
          );
        } catch (compensationErr) {
          throw new MaisterError(
            "CRASH",
            "adding the Flow failed and compensation requires recovery",
            {
              cause: compensationErr,
              details: { packageId: pkg.id, operationId: state.operationId },
            },
          );
        }
      }

      throw err;
    }

    const created = await getLocalPackage(pkg.id, opts.db);

    if (!created) {
      throw new MaisterError(
        "CRASH",
        "the local package disappeared after adding a Flow",
        { details: { packageId: pkg.id, operationId: state.operationId } },
      );
    }

    return { package: created, flowPath: artifacts.flowPath };
  } finally {
    await releaseWorkingDirLock(opts.packageId, lockToken, opts.db);
  }
}

// Replays only the verified, hash-addressed artifact write described by the
// private journal. A diverged working tree is never overwritten: it is marked
// recovery_required and remains visible for an operator to inspect.
export async function recoverLocalPackageCreation(
  packageId: string,
  db?: Db,
): Promise<{
  package: LocalPackage | null;
  flowPath: string | null;
  recoveryStatus: "ready" | "recovering" | "recovery_required" | "rolled_back";
}> {
  const lockToken = await acquireWorkingDirLock(packageId, db);

  try {
    const pkg = await getLocalPackage(packageId, db);

    if (!pkg || pkg.status !== "active") {
      throw new MaisterError("PRECONDITION", "local package not found");
    }

    const state = pkg.creationState;

    if (!state) {
      return {
        package: pkg,
        flowPath: null,
        recoveryStatus: "ready",
      };
    }

    if (state.kind === "create_package_with_flow") {
      const stagingDir = localPackageCreationStagingDir(
        pkg.workingDir,
        state.operationId,
      );
      const [finalWorkingDirExists, journal] = await Promise.all([
        pathExists(pkg.workingDir),
        readCreationJournal(stagingDir, state.operationId),
      ]);

      // Before the private journal is atomically written no Flow payload is
      // durable by design. The final working directory has not been claimed,
      // so compensation can delete only this operation's private stage and DB
      // row. A pre-existing final path is never adopted or removed.
      if (!journal && !finalWorkingDirExists) {
        try {
          await compensateUnjournaledInitialCreation(pkg, state, db);
        } catch (err) {
          await markCreationRecoveryRequired(packageId, state, db);
          throw err;
        }

        return {
          package: null,
          flowPath: null,
          recoveryStatus: "rolled_back",
        };
      }
    }

    try {
      await materializeCreation(pkg, state, db);
    } catch (err) {
      const fresh = await getLocalPackage(packageId, db);

      if (fresh?.creationState?.phase !== "recovery_required") {
        await markCreationRecoveryRequired(packageId, state, db);
      }
      throw err;
    }

    const recovered = await getLocalPackage(packageId, db);

    if (!recovered) {
      throw new MaisterError(
        "CRASH",
        "the local package disappeared while recovering Flow creation",
        { details: { packageId, operationId: state.operationId } },
      );
    }

    log.info(
      { packageId, flowId: state.flowId, operationId: state.operationId },
      "recovered local package Flow creation",
    );

    return {
      package: recovered,
      flowPath: flowYamlPath(state.flowId),
      recoveryStatus: creationRecoveryStatus(recovered),
    };
  } finally {
    await releaseWorkingDirLock(packageId, lockToken, db);
  }
}

export async function listLocalPackages(db?: Db): Promise<LocalPackage[]> {
  return resolveDb(db)
    .select()
    .from(lp)
    .where(eq(lp.status, "active"))
    .orderBy(desc(lp.updatedAt));
}

// Active AND archived, newest first — the /studio/local management list (archived
// rows sit behind a client-side toggle). `listLocalPackages` stays active-only
// for every other reader (the API list route, attach flows).
export async function listAllLocalPackages(db?: Db): Promise<LocalPackage[]> {
  return resolveDb(db).select().from(lp).orderBy(desc(lp.updatedAt));
}

export async function listSourceInstallsForLocalPackages(
  localPackages: readonly LocalPackage[],
  db?: Db,
): Promise<Map<string, LocalPackageSourceInstall>> {
  const sourceInstallIds = [
    ...new Set(
      localPackages.flatMap((pkg) =>
        pkg.sourceInstallId ? [pkg.sourceInstallId] : [],
      ),
    ),
  ];

  if (sourceInstallIds.length === 0) return new Map();

  const rows = await resolveDb(db)
    .select({
      id: schema.packageInstalls.id,
      name: schema.packageInstalls.name,
      versionLabel: schema.packageInstalls.versionLabel,
    })
    .from(schema.packageInstalls)
    .where(inArray(schema.packageInstalls.id, sourceInstallIds));

  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = sourceInstallIds.filter((id) => !byId.has(id));

  if (missing.length > 0) {
    throw new MaisterError(
      "CONFIG",
      `local package source installs not found: ${missing.join(", ")}`,
      { details: { sourceInstallIds: missing } },
    );
  }

  return byId;
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
// the winner's row (NEVER a read-then-write SELECT/TOCTOU). Each attempt derives
// its OWN unique slug/working dir, so the loser rolls back only its OWN orphan
// scaffold below — never the winner's adopted dir.
export async function ensureDefaultLocalPackage(opts: {
  projectId: string;
  projectName: string;
  createdBy: string;
  db?: Db;
}): Promise<LocalPackage> {
  const existing = await getDefaultLocalPackage(opts.projectId, opts.db);

  if (existing) return existing;

  const name = `${opts.projectName} (local)`;
  // A per-attempt UNIQUE slug (uuid tail) — NOT the racy read-then-act
  // `uniqueSlugForName`. Two concurrent first-fork callers must never derive the
  // same working dir (else the insert loser's rollback `rm` would delete the
  // winner's repo — data loss) nor collide on the slug-unique constraint (which
  // would raise a stray 23505 instead of the intended `(project_id)` arbiter
  // no-op). The user-facing name stays clean; the slug is an internal handle.
  const slug = `${slugifyName(name)}-${randomUUID().slice(0, 8)}`;
  const workingDir = localPackageWorkingDir(slug);

  log.info({ projectId: opts.projectId, slug }, "ensure default local package");
  await claimLocalPackageWorkingDir(workingDir);

  try {
    await scaffoldWorkingDir(workingDir, slug, name);
    await gitInitWithCommit(
      workingDir,
      DEFAULT_BRANCH,
      "maister: init default local package",
    );
  } catch (err) {
    await removeOwnedLocalPackageWorkingDir(workingDir);
    throw err;
  }

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
  await removeOwnedLocalPackageWorkingDir(workingDir);
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
  const current = await getLocalPackage(id, db);

  if (!current) return null;
  assertLocalPackageCreationReady(current);

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
  const database = resolveDb(db);
  const current = await getLocalPackage(id, db);

  if (!current) return null;
  assertLocalPackageCreationReady(current);

  if (status === "archived") {
    await assertNoLiveLocalPackageAssistants(id, database);
  }

  const rows = await database
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
  const database = resolveDb(db);
  const row = await getLocalPackage(id, db);

  if (!row) return;
  assertLocalPackageCreationReady(row);

  if (row.projectId !== null || row.isDefault) {
    throw new MaisterError(
      "PRECONDITION",
      `local package "${row.name}" is attached to a project and cannot be deleted`,
    );
  }
  if (
    row.lockedBySession !== null &&
    row.lockExpiresAt !== null &&
    row.lockExpiresAt.getTime() > Date.now()
  ) {
    throw new MaisterError(
      "CONFLICT",
      `local package "${row.name}" is locked for editing — close the editor or wait for the lock to expire`,
    );
  }

  await assertNoLiveLocalPackageAssistants(id, database);

  const deleted = await database
    .delete(lp)
    .where(
      and(
        eq(lp.id, id),
        isNull(lp.projectId),
        eq(lp.isDefault, false),
        or(
          isNull(lp.lockedBySession),
          isNull(lp.lockExpiresAt),
          sql`${lp.lockExpiresAt} <= now()`,
        ),
      ),
    )
    .returning();

  if (deleted.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      `local package "${row.name}" changed while deleting — reload and try again`,
    );
  }

  // Explicit user delete removes the working dir; there is no background GC
  // (owner decision) — orphans from a crash mid-delete are cleaned manually.
  await rm(row.workingDir, { recursive: true, force: true }).catch((err) =>
    log.warn(
      { packageId: row.id, packageSlug: row.slug, err },
      "working dir rm failed (left for manual cleanup)",
    ),
  );
  log.info({ id, slug: row.slug }, "deleted local package + working dir");
}

async function assertNoLiveLocalPackageAssistants(
  localPackageId: string,
  db: Db,
): Promise<void> {
  const rows = await db
    .select({ id: schema.runs.id, status: schema.runs.status })
    .from(schema.runs)
    .where(eq(schema.runs.localPackageId, localPackageId));
  const live = rows.find(
    (row) => !TERMINAL_LOCAL_ASSISTANT_RUN_STATUSES.has(row.status),
  );

  if (live) {
    throw new MaisterError(
      "CONFLICT",
      `local package has a recoverable or live assistant run (${live.id}, ${live.status})`,
      { details: { reason: "assistant_active" } },
    );
  }
}

export async function listFiles(
  pkg: LocalPackage,
): Promise<LocalPackageFileMeta[]> {
  const files: LocalPackageFileMeta[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (isLocalPackageInternalEntryName(entry.name)) continue;

      const abs = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      const rel = path.relative(pkg.workingDir, abs).split(path.sep).join("/");

      if (isLocalPackageInternalPath(rel)) continue;
      files.push({ path: rel, kind: classifyPackageFilePath(rel) });
    }
  }

  try {
    await walk(pkg.workingDir);
  } catch (err) {
    if (!isEnoent(err)) throw err;
    throw new MaisterError(
      "CONFIG",
      `local-package working dir is missing: ${pkg.workingDir}`,
    );
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
    kind: classifyPackageFilePath(relPath.split(path.sep).join("/")),
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
  assertLocalPackageCreationReady(pkg);
  const abs = await resolveWithinWorkingDir(pkg.workingDir, relPath);

  await mkdir(path.dirname(abs), { recursive: true });
  await atomicWriteText(abs, content);

  return {
    path: relPath.split(path.sep).join("/"),
    kind: classifyPackageFilePath(relPath.split(path.sep).join("/")),
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

// (M39 A4) After a flow element is copied into a package, register it in the
// manifest's `flows[]` — otherwise the forked flow is invisible to the installer
// (`installPackageRevision` loops `manifest.flows`) and is dead weight. A flow is
// a dir holding `flow.yaml` (manifest `flows[].path` points at the dir) or a bare
// `flow.yaml`. A non-flow element (skill / agent / rule) is a no-op.
export async function registerFlowElementInManifest(
  pkg: LocalPackage,
  elementPath: string,
  isDirectory: boolean,
): Promise<void> {
  assertLocalPackageCreationReady(pkg);
  let flowDir: string | null = null;

  if (isDirectory) {
    const flowYaml = path.join(pkg.workingDir, elementPath, "flow.yaml");
    const hasFlowYaml = await fsReadFile(flowYaml, "utf8").then(
      () => true,
      () => false,
    );

    if (hasFlowYaml) flowDir = elementPath;
  } else if ((elementPath.split(/[\\/]/).at(-1) ?? "") === "flow.yaml") {
    const parent = elementPath.replace(/[\\/]?flow\.yaml$/, "");

    flowDir = parent.length > 0 ? parent : null;
  }

  if (!flowDir) return;

  // ADR-106: the manifest flow id MUST equal the copied flow.yaml `name` — the
  // installer enforces id === flow.yaml.name, so deriving the id from the dir
  // basename (`flows/dev` → `dev`) forks an UNCUTTABLE package when the two
  // differ (`name: aif-dev`). Parse it with the SAME loader the installer uses;
  // a malformed copy fails fast rather than registering a wrong id.
  const flowManifest = await loadFlowManifest(
    path.join(pkg.workingDir, flowDir, "flow.yaml"),
  );
  const id = flowManifest.name;
  const manifestAbs = path.join(pkg.workingDir, "maister-package.yaml");
  const current = await fsReadFile(manifestAbs, "utf8").catch(() => null);

  if (current === null) return;

  const parsed = parsePackageManifest(current);

  if (!parsed.ok) return;
  await atomicWriteText(
    manifestAbs,
    appendManifestFlow(parsed.raw, { id, path: flowDir }),
  );
}

// Confined delete of a working-dir file (M36 T2.3). Idempotent (`force`); a
// missing file is not an error. Lock-asserted by the caller.
export async function deleteWorkingDirFile(
  pkg: LocalPackage,
  relPath: string,
): Promise<void> {
  assertLocalPackageCreationReady(pkg);
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
  await ensureLocalPackageGitExclude(pkg.workingDir);
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

// Read every regular working-dir file (path + utf8 content) for the commit gate.
// A binary asset decodes lossily, but the gate never content-validates assets
// (freeform) and only reads CHANGED-path content + sibling PATHS — so a lossy
// asset is harmless. A file that vanished between list and read is skipped.
export async function readWorkingDirArtifactFiles(
  pkg: LocalPackage,
): Promise<PackageArtifactFile[]> {
  const metas = await listFiles(pkg);
  const out: PackageArtifactFile[] = [];

  for (const meta of metas) {
    try {
      const abs = await resolveWithinWorkingDir(pkg.workingDir, meta.path);

      out.push({ path: meta.path, content: await fsReadFile(abs, "utf8") });
    } catch {
      // vanished/unreadable mid-read — not committable content, skip
    }
  }

  return out;
}

// (M39 ADR-105, Phase A3) The commit-time validation gate. Validates ONLY the
// artifacts THIS commit changes (already-committed artifacts are assumed valid —
// owner decision) and HARD-BLOCKS the commit (throws `PRECONDITION`, nothing is
// written) on any invalid flow / manifest / platform-agent / skill. The
// per-artifact error list rides on `details.invalidArtifacts` so the editor's
// change-review dialog can render it. EVERY commit entry point flows through
// `commitWorkingDir`, which calls this first — so an invalid artifact can never
// become a committed (and therefore launchable) version.
export async function assertPackageCommittable(
  pkg: LocalPackage,
): Promise<void> {
  assertLocalPackageCreationReady(pkg);
  await ensureLocalPackageGitExclude(pkg.workingDir);
  const wt = await diffWorkingTree(pkg.workingDir);
  const changedPaths = [
    ...new Set(
      wt.nameStatus.flatMap((entry) =>
        entry.oldPath ? [entry.path, entry.oldPath] : [entry.path],
      ),
    ),
  ];

  if (changedPaths.length === 0) return;

  const files = await readWorkingDirArtifactFiles(pkg);
  const errors = validatePackageArtifacts({ files, changedPaths });

  if (errors.length === 0) return;

  log.warn(
    {
      slug: pkg.slug,
      invalidCount: errors.length,
      paths: errors.map((e) => e.path),
    },
    "commit blocked — invalid artifacts",
  );
  throw new MaisterError(
    "PRECONDITION",
    `${errors.length} artifact(s) failed validation and cannot be committed`,
    { details: { invalidArtifacts: errors } },
  );
}

// Commit every working-tree change to the local-package branch (M36 T4.1). The
// caller MUST have asserted the session edit-lock first; this is the git side
// only. The commit-time validation gate (`assertPackageCommittable`) runs FIRST
// — a package with an invalid changed artifact never commits.
export async function commitWorkingDir(
  pkg: LocalPackage,
  message?: string,
): Promise<void> {
  await assertPackageCommittable(pkg);
  await gitCommitWorkingDir(
    pkg.workingDir,
    message?.trim() ? message.trim() : "maister: edit local package",
  );
}

// (M39 ADR-105 D3) The cut-time gate: a version may be cut ONLY from a clean,
// committed, fully-valid working tree — committed state is the validation
// boundary, so publishing uncommitted WIP or an invalid committed baseline is
// refused. Called by the cut-version route BEFORE the export/install. Unlike the
// commit gate (changed paths only), this validates EVERY artifact, catching an
// invalid baseline that a scoped commit never re-checked.
export async function assertPackageCuttable(pkg: LocalPackage): Promise<void> {
  assertLocalPackageCreationReady(pkg);
  await ensureLocalPackageGitExclude(pkg.workingDir);
  const wt = await diffWorkingTree(pkg.workingDir);

  if (wt.nameStatus.length > 0) {
    log.warn(
      { slug: pkg.slug, changedCount: wt.nameStatus.length },
      "cut blocked — uncommitted working-tree changes",
    );
    throw new MaisterError(
      "PRECONDITION",
      "commit or discard working-tree changes before cutting a version",
      { details: { changedCount: wt.nameStatus.length } },
    );
  }

  const files = await readWorkingDirArtifactFiles(pkg);
  const errors = validatePackageArtifacts({
    files,
    changedPaths: files.map((f) => f.path),
  });

  if (errors.length === 0) return;

  log.warn(
    {
      slug: pkg.slug,
      invalidCount: errors.length,
      paths: errors.map((e) => e.path),
    },
    "cut blocked — invalid artifacts",
  );
  throw new MaisterError(
    "PRECONDITION",
    `${errors.length} artifact(s) failed validation and cannot be cut`,
    { details: { invalidArtifacts: errors } },
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
  assertLocalPackageCreationReady(pkg);
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
    recoveryStatus: creationRecoveryStatus(row),
  };
}
