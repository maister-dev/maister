import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { FlowRevisionExecTrust } from "@/lib/db/schema";
import type { TrustStatus } from "@/lib/flows/trust";

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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

import { loadFlowManifest, type CapabilityRefIdsInput } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { manifestDigest } from "@/lib/flows/digest";
import { readAuthoredFlowPackageDirectory } from "@/lib/flows/package-authoring";
import { resolveTrust } from "@/lib/flows/trust";
import {
  flowIdSchema,
  flowRevisionSchema,
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

// First 40 hex chars of the local package sha256 — content-addresses all local
// source bytes while satisfying the 40-hex revision schema (flow-paths).
const LOCAL_REVISION_LEN = 40;

// ADR-087: validate a package-supplied revision override at this sink's
// invariant (40-hex SHA / digest) before it can reach systemCachePath.
function parseRevisionOverride(
  override: string | undefined,
  flowId: string,
): string | undefined {
  if (override === undefined) return undefined;

  const parsed = flowRevisionSchema.safeParse(override);

  if (!parsed.success || parsed.data === "unknown") {
    throw new MaisterError(
      "FLOW_INSTALL",
      `Invalid resolvedRevisionOverride for flow "${flowId}": must be a 40-char hex revision`,
    );
  }

  log.debug(
    { flowId, override: parsed.data.slice(0, 12) },
    "revision override applied (package sub-install)",
  );

  return parsed.data;
}

const inFlightInstalls = new Map<string, Promise<InstallResult>>();

export type InstallFlowPluginArgs = {
  source: string;
  version: string;
  projectId: string;
  projectSlug: string;
  flowId: string;
  workspaceRoot?: string;
  roleRefs?: readonly string[];
  // Project capability registry (block + capability_imports), built by the
  // register flow via buildCapabilityRefIds(cfg). When supplied, the manifest
  // loader rejects node settings refs absent from it (M14 carve-b). Omitted by
  // generic callers (enable/upgrade) that have no project context → no check.
  capabilityRefIds?: CapabilityRefIdsInput;
  // Override the exec_trust value written to flow_revisions. When absent,
  // exec_trust is derived from trustStatus: trusted_by_policy → 'trusted',
  // untrusted → 'untrusted'. Authored-bridge callers set this to 'untrusted'
  // to suppress setup.sh execution regardless of logic-trust (§4.2, §6.4).
  execTrustOverride?: FlowRevisionExecTrust;
  // ADR-087: package sub-installs inherit the PACKAGE's resolved revision
  // (tag SHA or package content digest) so all members share one immutable
  // cache key and `runs.flow_revision` pinning stays content-addressed.
  // Validated against flowRevisionSchema shape before use.
  resolvedRevisionOverride?: string;
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
  // "pending" => setup.sh exists but was deferred (untrusted install); it runs
  // later, only after trust is confirmed, via runRevisionSetup.
  setupStatus: "not_required" | "pending" | "done" | "failed";
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

  // ADR-087: validate the package-supplied revision override before any
  // I/O or DB access (parseRevisionOverride re-asserts inside installRevision
  // for direct callers).
  parseRevisionOverride(args.resolvedRevisionOverride, args.flowId);
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

export async function gitClone(opts: {
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

// Low-level setup.sh runner. NEVER call this from the install path — it
// executes arbitrary package code and must only run once trust is established
// (see runRevisionSetup). Returns the resulting setup_status; a non-zero exit
// returns "failed" (the caller marks the revision Failed).
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
export async function gitRevParseHead(opts: {
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

export async function localDirectoryContentDigest(
  sourceDir: string,
): Promise<string> {
  const root = resolvePath(sourceDir);
  const entries = await listLocalDirectoryDigestEntries(root);
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
): Promise<LocalDirectoryDigestEntry[]> {
  const entries: LocalDirectoryDigestEntry[] = [];

  async function walk(dir: string): Promise<void> {
    const dirEntries = await readdir(dir, { withFileTypes: true });

    for (const entry of dirEntries) {
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

async function loadManifestOrThrow(
  flowYamlPath: string,
  source: string,
  version: string,
  opts: {
    roleRefs?: readonly string[];
    capabilityRefIds?: CapabilityRefIdsInput;
  } = {},
): Promise<FlowYamlV1> {
  try {
    return await loadFlowManifest(flowYamlPath, {
      roleRefs: opts.roleRefs,
      capabilityRefIds: opts.capabilityRefIds,
    });
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
  roleRefs?: readonly string[];
  capabilityRefIds?: CapabilityRefIdsInput;
  resolvedRevisionOverride?: string;
  db?: any;
  signal?: AbortSignal;
}): Promise<InstalledRevision> {
  const { source, version, flowId, roleRefs, signal, capabilityRefIds } = opts;
  const db = opts.db ?? getDb();
  const revisionOverride = parseRevisionOverride(
    opts.resolvedRevisionOverride,
    flowId,
  );

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
      { roleRefs, capabilityRefIds },
    );
    resolvedRevision =
      revisionOverride ??
      (await localDirectoryContentDigest(sourceKind.absPath)).slice(
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
      resolvedRevision =
        revisionOverride ??
        (await gitRevParseHead({
          dir: tmpDir,
          source,
          version,
          signal,
        }));
      target = systemCachePath(flowId, resolvedRevision);
      manifestForIntent = await loadManifestOrThrow(
        join(tmpDir, "flow.yaml"),
        source,
        version,
        { roleRefs, capabilityRefIds },
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
        { roleRefs, capabilityRefIds },
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
      { roleRefs, capabilityRefIds },
    );

    // SECURITY (ADR-021): NEVER execute a package's setup.sh during install —
    // that would run arbitrary code from a possibly-untrusted source on the web
    // host before any trust decision. The revision records setupStatus
    // `not_required` (no setup.sh) or `pending` (deferred). setup.sh runs later,
    // only after trust is confirmed, via runRevisionSetup (called by the
    // trusted-by-policy auto-enable path or the explicit enable step).
    const setupStatus: InstalledRevision["setupStatus"] = (await pathExists(
      join(target, "setup.sh"),
    ))
      ? "pending"
      : "not_required";

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
      "flow revision install complete (setup deferred until trust+enable)",
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

// Execute a revision's setup.sh AFTER trust is confirmed (ADR-021). Idempotent
// via the once-only sentinel. On success -> setupStatus='done'; on failure ->
// setupStatus='failed' AND packageStatus='Failed' (a failed setup is not a
// usable Installed revision — Codex finding #3). Callers MUST have established
// trust first (trusted_by_policy at install, or explicit project trust at the
// enable step) — installRevision never runs setup.
export async function runRevisionSetup(opts: {
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
  revisionId: string;
  installedPath: string;
  signal?: AbortSignal;
}): Promise<"not_required" | "done" | "failed"> {
  const db = opts.db ?? getDb();
  const setupStatus = await runSetupSh({
    target: opts.installedPath,
    signal: opts.signal,
  });

  await db
    .update(flowRevisions)
    .set({
      setupStatus,
      ...(setupStatus === "failed" ? { packageStatus: "Failed" } : {}),
    })
    .where(eq(flowRevisions.id, opts.revisionId));

  log.info({ revisionId: opts.revisionId, setupStatus }, "revision setup run");

  return setupStatus;
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
  const denorm = {
    source: opts.source,
    version: opts.version,
    revision: opts.resolvedRevision,
    installedPath: opts.installedPath,
    manifest: opts.manifest,
    schemaVersion: opts.manifest.schemaVersion,
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
  trustStatusOverride?: TrustStatus,
): Promise<InstallResult> {
  const { source, version, projectId, projectSlug, flowId, roleRefs, signal } =
    args;
  const workspaceRoot = args.workspaceRoot ?? process.cwd();
  const db = args.db ?? getDb();

  const rev = await installRevision({
    source,
    version,
    flowId,
    roleRefs,
    db,
    signal,
    capabilityRefIds: args.capabilityRefIds,
    resolvedRevisionOverride: args.resolvedRevisionOverride,
  });

  const trustStatus = trustStatusOverride ?? resolveTrust(source);

  // Two-axis trust gate (§4.2, §6.4):
  //   execTrust = 'trusted'   → setup.sh runs at install (git/policy path).
  //   execTrust = 'untrusted' → setup.sh deferred until explicit flip.
  // authored-bridge passes execTrustOverride='untrusted' to suppress setup.sh
  // even when logic-trust is trusted_by_policy.
  const execTrust: FlowRevisionExecTrust =
    args.execTrustOverride ??
    (trustStatus === "untrusted" ? "untrusted" : "trusted");

  await db
    .update(flowRevisions)
    .set({ execTrust })
    .where(eq(flowRevisions.id, rev.revisionId));

  // git/policy installs (execTrust=trusted) run setup.sh now; authored-bridge
  // installs (execTrust=untrusted) skip setup and auto-enable without it.
  let enablementState: "Enabled" | "Installed" = "Installed";

  if (execTrust === "trusted") {
    const setupStatus =
      rev.setupStatus === "pending"
        ? await runRevisionSetup({
            db,
            revisionId: rev.revisionId,
            installedPath: rev.installedPath,
            signal,
          })
        : rev.setupStatus;

    if (setupStatus === "failed") {
      log.warn(
        { flowId, revisionId: rev.revisionId },
        "trusted-by-policy setup.sh failed; leaving package Installed (not enabled)",
      );
    } else {
      enablementState = "Enabled";
    }
  } else {
    // exec-untrusted authored install: auto-enable (without setup.sh) only when
    // logic-trust is trusted_by_policy. If trustStatus is 'untrusted', the flow
    // stays Installed until trust is explicitly confirmed (same as the git path).
    enablementState =
      trustStatus === "trusted_by_policy" ? "Enabled" : "Installed";
  }

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
  // ADR-087: package installs derive trust from the ORIGINAL package source
  // (file:// sub-sources are always policy-trusted and would loosen the gate
  // for git packages). Mirrors the authored-bridge override seam.
  trustStatusOverride?: TrustStatus,
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

  const promise = installFlowPluginImpl(args, trustStatusOverride).finally(
    () => {
      inFlightInstalls.delete(dedupKey);
    },
  );

  inFlightInstalls.set(dedupKey, promise);

  return promise;
}

export async function installAuthoredFlowPackageBridge(
  args: InstallFlowPluginArgs,
  trustStatusOverride?: TrustStatus,
): Promise<InstallResult> {
  validateBoundary(args);
  const source = resolvePath(args.source);
  const packageBody = await readAuthoredFlowPackageDirectory(source);

  if (packageBody.validation.status !== "valid") {
    log.warn(
      {
        projectId: args.projectId,
        projectSlug: args.projectSlug,
        flowId: args.flowId,
        source,
        issueCount: packageBody.validation.issueCount,
        issues: packageBody.validation.issues.map((issue) => ({
          code: issue.code,
          path: issue.path,
        })),
      },
      "authored Flow package bridge install refused",
    );

    throw new MaisterError(
      "CONFIG",
      `cannot install invalid authored Flow package ${packageBody.packageMetadata.slug}: ${packageBody.validation.issueCount} validation issue(s)`,
    );
  }

  log.info(
    {
      projectId: args.projectId,
      projectSlug: args.projectSlug,
      flowId: args.flowId,
      source,
      version: args.version,
      trustStatusOverride,
    },
    "install authored Flow package bridge start",
  );

  return installFlowPluginImpl(
    { ...args, source, execTrustOverride: "untrusted" },
    trustStatusOverride ?? "untrusted",
  );
}
