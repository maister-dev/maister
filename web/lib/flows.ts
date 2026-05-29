import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { TrustStatus } from "@/lib/flows/trust";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path, { dirname, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import { loadFlowManifest } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { manifestDigest } from "@/lib/flows/digest";
import { resolveTrust } from "@/lib/flows/trust";
import {
  flowIdSchema,
  projectFlowSymlinkPath,
  projectSlugSchema,
  sourceUrlSchema,
  systemCachePath,
  versionTagSchema,
} from "@/lib/flow-paths";

// FIXME(any): dual drizzle-orm peer-dep variants (see schema.integration.test.ts).
const { flows, flowRevisions } = schemaModule as unknown as Record<string, any>;

const execFileAsync = promisify(execFile);

const log = pino({
  name: "flows",
  level: process.env.LOG_LEVEL ?? "info",
});

const CLONE_TIMEOUT_MS = 120_000;
const SETUP_SH_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

// First 40 hex chars of the manifest sha256 — content-addresses local sources
// while satisfying the 40-hex revision schema (flow-paths). The full digest is
// stored separately in flow_revisions.manifest_digest.
const LOCAL_REVISION_LEN = 40;

const inFlightInstalls = new Map<string, Promise<InstallResult>>();

export type InstallFlowPluginArgs = {
  source: string;
  version: string;
  projectId: string;
  projectSlug: string;
  flowId: string;
  workspaceRoot?: string;
  // FIXME(any): dual drizzle-orm peer-dep variants. Caller may pass
  // either a node-postgres or better-sqlite3 drizzle client.
  db?: any;
  signal?: AbortSignal;
};

export type InstallResult = {
  // The project `flows` enablement row id.
  flowRowId: string;
  // The immutable `flow_revisions` row id this install resolved/created.
  revisionId: string;
  installedPath: string;
  symlinkPath: string;
  manifest: FlowYamlV1;
  // Resolved revision: git SHA (40 hex) or the local manifest-digest prefix.
  revision: string;
  trustStatus: TrustStatus;
  // 'Enabled' for trusted-by-policy sources (one-shot register UX),
  // 'Installed' for untrusted sources (await explicit trust + enable).
  enablementState: "Enabled" | "Installed";
};

// A revision installed into the global content-addressed cache + flow_revisions.
export type InstalledRevision = {
  revisionId: string;
  resolvedRevision: string;
  installedPath: string;
  manifest: FlowYamlV1;
  setupStatus: "not_required" | "done" | "failed";
};

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function wrapInstall(message: string, cause: unknown): MaisterError {
  return new MaisterError("FLOW_INSTALL", message, { cause: asError(cause) });
}

// Structured FLOW_INSTALL detail per ADR-021 (source, version, stage, ...).
function wrapInstallStage(opts: {
  source: string;
  version: string;
  stage: string;
  message: string;
  cause?: unknown;
}): MaisterError {
  return new MaisterError(
    "FLOW_INSTALL",
    `flow install failed [stage=${opts.stage}] ${opts.source}@${opts.version}: ${opts.message}`,
    opts.cause ? { cause: asError(opts.cause) } : undefined,
  );
}

function validateBoundary(args: InstallFlowPluginArgs): void {
  const fields: Array<[ReturnType<typeof flowIdSchema.safeParse>, string]> = [
    [flowIdSchema.safeParse(args.flowId), "flowId"],
    [versionTagSchema.safeParse(args.version), "version"],
    [projectSlugSchema.safeParse(args.projectSlug), "projectSlug"],
    [sourceUrlSchema.safeParse(args.source), "source"],
  ];

  for (const [parsed, name] of fields) {
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => i.message).join("; ");

      throw new MaisterError("FLOW_INSTALL", `Invalid ${name}: ${msg}`);
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);

    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function buildExecSignal(
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  if (!userSignal) return timeoutSignal;

  return AbortSignal.any([userSignal, timeoutSignal]);
}

async function gitClone(opts: {
  source: string;
  version: string;
  target: string;
  signal?: AbortSignal;
}): Promise<void> {
  log.debug(
    { source: opts.source, version: opts.version, target: opts.target },
    "git clone start",
  );

  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      [
        "clone",
        "--branch",
        opts.version,
        "--depth",
        "1",
        "--single-branch",
        opts.source,
        opts.target,
      ],
      {
        signal: buildExecSignal(opts.signal, CLONE_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );

    log.debug({ stdout, stderr, target: opts.target }, "git clone done");
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: string };
    const detail = e.stderr ? `: ${e.stderr.trim()}` : "";

    throw wrapInstallStage({
      source: opts.source,
      version: opts.version,
      stage: "clone",
      message: `command="git clone --branch ${opts.version} --depth 1 ${opts.source}" exitStatus=${e.code ?? "unknown"}${detail}`,
      cause: err,
    });
  }
}

export async function ensureSymlink(opts: {
  target: string;
  linkPath: string;
}): Promise<void> {
  const { target, linkPath } = opts;

  await mkdir(dirname(linkPath), { recursive: true });

  let st;

  try {
    st = await lstat(linkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw wrapInstall(`lstat failed for ${linkPath}`, err);
    }

    log.debug({ target, linkPath }, "symlink: creating fresh");
    await symlink(target, linkPath);

    return;
  }

  if (!st.isSymbolicLink()) {
    throw new MaisterError(
      "FLOW_INSTALL",
      `refuse to overwrite non-symlink at ${linkPath}`,
    );
  }

  const currentTarget = await readlink(linkPath);
  const resolvedCurrent = resolvePath(dirname(linkPath), currentTarget);

  if (currentTarget === target || resolvedCurrent === resolvePath(target)) {
    log.debug({ target, linkPath }, "symlink: already correct");

    return;
  }

  log.debug(
    { target, linkPath, previousTarget: currentTarget },
    "symlink: repointing",
  );
  await unlink(linkPath);
  await symlink(target, linkPath);
}

const SETUP_DONE_SENTINEL = ".maister-setup-done";

// Returns the resulting setup_status. Setup failures do NOT abort the install
// (POC trusts internal sources, and the failure is surfaced via setup_status,
// which the launch precondition refuses on).
async function runSetupSh(opts: {
  target: string;
  signal?: AbortSignal;
}): Promise<"not_required" | "done" | "failed"> {
  const setupPath = join(opts.target, "setup.sh");

  if (!(await pathExists(setupPath))) {
    log.debug({ target: opts.target }, "no setup.sh, skipping");

    return "not_required";
  }

  const sentinelPath = join(opts.target, SETUP_DONE_SENTINEL);

  if (await pathExists(sentinelPath)) {
    log.debug(
      { target: opts.target, sentinelPath },
      "setup.sh sentinel present, skipping (once-only semantic)",
    );

    return "done";
  }

  log.info({ setupPath }, "running setup.sh");

  try {
    const { stdout, stderr } = await execFileAsync("bash", [setupPath], {
      cwd: opts.target,
      signal: buildExecSignal(opts.signal, SETUP_SH_TIMEOUT_MS),
      maxBuffer: EXEC_MAX_BUFFER,
    });

    log.debug({ stdout, stderr, setupPath }, "setup.sh done");
    await writeFile(sentinelPath, new Date().toISOString(), "utf8");

    return "done";
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };

    if (e.name === "AbortError") {
      log.info({ setupPath }, "setup.sh aborted by signal");

      throw wrapInstall(`setup.sh aborted for ${setupPath}`, err);
    }

    log.warn(
      { err: e.message, stderr: e.stderr, setupPath },
      "setup.sh non-zero exit; revision marked setup_status=failed",
    );

    return "failed";
  }
}

// Capture the upstream git commit SHA inside an already-cloned directory.
async function gitRevParseHead(opts: {
  dir: string;
  source: string;
  version: string;
  signal?: AbortSignal;
}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", opts.dir, "rev-parse", "HEAD"],
      {
        signal: buildExecSignal(opts.signal, CLONE_TIMEOUT_MS),
        maxBuffer: EXEC_MAX_BUFFER,
      },
    );
    const sha = stdout.trim();

    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`rev-parse HEAD returned non-hex output: ${sha}`);
    }

    return sha;
  } catch (err) {
    throw wrapInstallStage({
      source: opts.source,
      version: opts.version,
      stage: "resolve-revision",
      message: `git rev-parse HEAD failed in ${opts.dir}: ${asError(err).message}`,
      cause: err,
    });
  }
}

export type LocalDirectorySourceResult =
  | { kind: "local"; absPath: string }
  | { kind: "git" };

export async function isLocalDirectorySource(
  source: string,
): Promise<LocalDirectorySourceResult> {
  let candidate: string | null = null;

  if (source.startsWith("file://")) {
    try {
      candidate = fileURLToPath(source);
    } catch {
      candidate = null;
    }
  } else if (path.isAbsolute(source)) {
    candidate = source;
  }

  if (!candidate) return { kind: "git" };

  try {
    const st = await stat(candidate);

    if (!st.isDirectory()) return { kind: "git" };
    if (!(await pathExists(join(candidate, "flow.yaml")))) {
      return { kind: "git" };
    }
    if (await pathExists(join(candidate, ".git"))) {
      // Source is a git repo — let gitClone honor the version tag instead
      // of fs.cp-ing the working tree (which would ignore the tag).
      return { kind: "git" };
    }

    return { kind: "local", absPath: candidate };
  } catch {
    return { kind: "git" };
  }
}

async function loadManifestOrThrow(
  flowYamlPath: string,
  source: string,
  version: string,
): Promise<FlowYamlV1> {
  try {
    return await loadFlowManifest(flowYamlPath);
  } catch (err) {
    throw wrapInstallStage({
      source,
      version,
      stage: "validate-manifest",
      message: `flow.yaml invalid in ${flowYamlPath}: ${asError(err).message}`,
      cause: err,
    });
  }
}

function contractOf(manifest: FlowYamlV1): Record<string, unknown> {
  return {
    capabilities: manifest.capabilities ?? [],
    gates: manifest.gates ?? [],
    artifacts: manifest.artifacts ?? [],
    external_ops: manifest.external_ops ?? [],
  };
}

// Phase-1 of the two-phase install: ensure a durable flow_revisions intent row.
// Returns the row id plus whether the revision is already fully Installed on
// disk (idempotent short-circuit).
async function ensureRevisionIntentRow(opts: {
  db: any;
  flowId: string;
  source: string;
  version: string;
  resolvedRevision: string;
  installedPath: string;
  schemaVersionGuess: number;
  manifestForIntent: FlowYamlV1;
}): Promise<{ revisionId: string; skipFinalize: boolean }> {
  const intent = {
    id: randomUUID(),
    flowRefId: opts.flowId,
    source: opts.source,
    versionLabel: opts.version,
    resolvedRevision: opts.resolvedRevision,
    manifestDigest: manifestDigest(opts.manifestForIntent),
    manifest: opts.manifestForIntent,
    schemaVersion: opts.schemaVersionGuess,
    installedPath: opts.installedPath,
    packageStatus: "Installing" as const,
    setupStatus: "pending" as const,
  };

  const inserted: Array<{ id: string }> = await opts.db
    .insert(flowRevisions)
    .values(intent)
    .onConflictDoNothing({
      target: [flowRevisions.flowRefId, flowRevisions.resolvedRevision],
    })
    .returning({ id: flowRevisions.id });

  if (inserted[0]?.id) {
    return { revisionId: inserted[0].id, skipFinalize: false };
  }

  // Conflict: a row already exists for this (flowRefId, resolvedRevision).
  const existing: Array<{ id: string; packageStatus: string }> = await opts.db
    .select({
      id: flowRevisions.id,
      packageStatus: flowRevisions.packageStatus,
    })
    .from(flowRevisions)
    .where(
      and(
        eq(flowRevisions.flowRefId, opts.flowId),
        eq(flowRevisions.resolvedRevision, opts.resolvedRevision),
      ),
    );

  const row = existing[0];

  if (!row) {
    throw wrapInstallStage({
      source: opts.source,
      version: opts.version,
      stage: "intent",
      message: `revision row vanished for ${opts.flowId}@${opts.resolvedRevision}`,
    });
  }

  const onDisk = await pathExists(join(opts.installedPath, "flow.yaml"));

  if (row.packageStatus === "Installed" && onDisk) {
    return { revisionId: row.id, skipFinalize: true };
  }

  // A previous attempt left the row Failed/Installing, or the cache is gone.
  // Reset to Installing and re-run finalize.
  await opts.db
    .update(flowRevisions)
    .set({ packageStatus: "Installing" })
    .where(eq(flowRevisions.id, row.id));

  return { revisionId: row.id, skipFinalize: false };
}

// Install a Flow package revision into the global content-addressed cache and
// record an immutable flow_revisions row (two-phase). Does NOT touch any
// project enablement pointer — used by installFlowPlugin (install+enable) and
// by lifecycle.upgradeFlow (install beside).
export async function installRevision(opts: {
  source: string;
  version: string;
  flowId: string;
  db?: any;
  signal?: AbortSignal;
}): Promise<InstalledRevision> {
  const { source, version, flowId, signal } = opts;
  const db = opts.db ?? getDb();

  const sourceKind = await isLocalDirectorySource(source);

  let resolvedRevision: string;
  let target: string;
  let tmpDir: string | null = null;
  let manifestForIntent: FlowYamlV1;

  if (sourceKind.kind === "local") {
    manifestForIntent = await loadManifestOrThrow(
      join(sourceKind.absPath, "flow.yaml"),
      source,
      version,
    );
    resolvedRevision = manifestDigest(manifestForIntent).slice(
      0,
      LOCAL_REVISION_LEN,
    );
    target = systemCachePath(flowId, resolvedRevision);
  } else {
    tmpDir = await mkdtemp(
      path.join(os.tmpdir(), `maister-flow-clone-${flowId}-`),
    );

    try {
      await gitClone({ source, version, target: tmpDir, signal });
      resolvedRevision = await gitRevParseHead({
        dir: tmpDir,
        source,
        version,
        signal,
      });
      target = systemCachePath(flowId, resolvedRevision);
      manifestForIntent = await loadManifestOrThrow(
        join(tmpDir, "flow.yaml"),
        source,
        version,
      );
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  log.info(
    { flowId, version, source, resolvedRevision },
    "installing flow revision",
  );

  const { revisionId, skipFinalize } = await ensureRevisionIntentRow({
    db,
    flowId,
    source,
    version,
    resolvedRevision,
    installedPath: target,
    schemaVersionGuess: manifestForIntent.schemaVersion,
    manifestForIntent,
  });

  try {
    if (skipFinalize) {
      if (tmpDir)
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      log.info(
        { target, resolvedRevision },
        "revision already Installed; reusing cache",
      );

      const manifest = await loadManifestOrThrow(
        join(target, "flow.yaml"),
        source,
        version,
      );
      const setupRow: Array<{ setupStatus: InstalledRevision["setupStatus"] }> =
        await db
          .select({ setupStatus: flowRevisions.setupStatus })
          .from(flowRevisions)
          .where(eq(flowRevisions.id, revisionId));

      return {
        revisionId,
        resolvedRevision,
        installedPath: target,
        manifest,
        setupStatus: setupRow[0]?.setupStatus ?? "not_required",
      };
    }

    const cachePopulated =
      (await pathExists(target)) &&
      (await pathExists(join(target, "flow.yaml")));

    if (!cachePopulated) {
      await mkdir(dirname(target), { recursive: true });

      if (sourceKind.kind === "local") {
        await cp(sourceKind.absPath, target, {
          recursive: true,
          errorOnExist: false,
          force: false,
        });
        log.info({ target }, "local-copy-done");
      } else if (tmpDir) {
        await rename(tmpDir, target);
        tmpDir = null;
        log.info({ target, resolvedRevision }, "renamed clone to cache");
      }
    } else if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      tmpDir = null;
    }

    const manifest = await loadManifestOrThrow(
      join(target, "flow.yaml"),
      source,
      version,
    );
    const setupStatus = await runSetupSh({ target, signal });

    await db
      .update(flowRevisions)
      .set({
        packageStatus: "Installed",
        setupStatus,
        manifestDigest: manifestDigest(manifest),
        manifest,
        schemaVersion: manifest.schemaVersion,
        engineMin: manifest.compat?.engine_min ?? null,
        engineMax: manifest.compat?.engine_max ?? null,
        contract: contractOf(manifest),
      })
      .where(eq(flowRevisions.id, revisionId));

    log.info(
      { flowId, revisionId, resolvedRevision, target, setupStatus },
      "flow revision install complete",
    );

    return {
      revisionId,
      resolvedRevision,
      installedPath: target,
      manifest,
      setupStatus,
    };
  } catch (err) {
    await db
      .update(flowRevisions)
      .set({ packageStatus: "Failed" })
      .where(eq(flowRevisions.id, revisionId))
      .catch(() => {});
    if (tmpDir)
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

    if (err instanceof MaisterError) throw err;
    throw wrapInstallStage({
      source,
      version,
      stage: "finalize",
      message: asError(err).message,
      cause: err,
    });
  }
}

async function upsertFlowEnablementRow(opts: {
  db: any;
  projectId: string;
  flowId: string;
  source: string;
  version: string;
  resolvedRevision: string;
  installedPath: string;
  manifest: FlowYamlV1;
  enabledRevisionId: string;
  trustStatus: TrustStatus;
  enablementState: "Enabled" | "Installed";
}): Promise<string> {
  const id = randomUUID();
  const recommendedExecutorId = opts.manifest.recommended_executor ?? null;

  const denorm = {
    source: opts.source,
    version: opts.version,
    revision: opts.resolvedRevision,
    installedPath: opts.installedPath,
    manifest: opts.manifest,
    schemaVersion: opts.manifest.schemaVersion,
    recommendedExecutorId,
    enabledRevisionId: opts.enabledRevisionId,
    trustStatus: opts.trustStatus,
    enablementState: opts.enablementState,
    updatedAt: new Date(),
  };

  try {
    const rows = await opts.db
      .insert(flows)
      .values({
        id,
        projectId: opts.projectId,
        flowRefId: opts.flowId,
        ...denorm,
      })
      .onConflictDoUpdate({
        target: [flows.projectId, flows.flowRefId],
        set: denorm,
      })
      .returning({ id: flows.id });

    const rowId = rows[0]?.id;

    if (!rowId) {
      throw new Error("db upsert returned no row");
    }

    log.info(
      {
        flowRowId: rowId,
        flowRefId: opts.flowId,
        version: opts.version,
        enablementState: opts.enablementState,
        trustStatus: opts.trustStatus,
      },
      "upserted flow enablement row",
    );

    return rowId;
  } catch (err) {
    throw wrapInstall(
      `db upsert failed for flow ${opts.flowId}@${opts.version}`,
      err,
    );
  }
}

async function installFlowPluginImpl(
  args: InstallFlowPluginArgs,
): Promise<InstallResult> {
  const { source, version, projectId, projectSlug, flowId, signal } = args;
  const workspaceRoot = args.workspaceRoot ?? process.cwd();
  const db = args.db ?? getDb();

  const rev = await installRevision({ source, version, flowId, db, signal });

  const trustStatus = resolveTrust(source);
  // Trusted-by-policy sources auto-enable to preserve the one-shot register UX;
  // untrusted sources install but stay Installed until explicit trust + enable.
  const enablementState: "Enabled" | "Installed" =
    trustStatus === "trusted_by_policy" ? "Enabled" : "Installed";

  // The project symlink tracks the enabled revision's cache directory.
  const symlinkPath = projectFlowSymlinkPath(
    workspaceRoot,
    projectSlug,
    flowId,
  );

  await ensureSymlink({ target: rev.installedPath, linkPath: symlinkPath });
  log.info({ symlinkPath }, "symlink ready");

  const flowRowId = await upsertFlowEnablementRow({
    db,
    projectId,
    flowId,
    source,
    version,
    resolvedRevision: rev.resolvedRevision,
    installedPath: rev.installedPath,
    manifest: rev.manifest,
    enabledRevisionId: rev.revisionId,
    trustStatus,
    enablementState,
  });

  log.info(
    {
      flowId,
      version,
      revision: rev.resolvedRevision,
      flowRowId,
      revisionId: rev.revisionId,
      enablementState,
    },
    "flow plugin install complete",
  );

  return {
    flowRowId,
    revisionId: rev.revisionId,
    installedPath: rev.installedPath,
    symlinkPath,
    manifest: rev.manifest,
    revision: rev.resolvedRevision,
    trustStatus,
    enablementState,
  };
}

export async function installFlowPlugin(
  args: InstallFlowPluginArgs,
): Promise<InstallResult> {
  validateBoundary(args);

  // Dedup key includes projectId so concurrent installs of the same flow tag
  // to DIFFERENT projects each run their own per-project pipeline.
  const dedupKey = `${args.projectId}::${args.flowId}@${args.version}`;
  const existing = inFlightInstalls.get(dedupKey);

  if (existing) {
    log.debug({ dedupKey }, "join in-flight install");

    return existing;
  }

  const promise = installFlowPluginImpl(args).finally(() => {
    inFlightInstalls.delete(dedupKey);
  });

  inFlightInstalls.set(dedupKey, promise);

  return promise;
}
