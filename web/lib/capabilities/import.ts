import "server-only";

import type { TrustStatus } from "@/lib/flows/trust";
import type {
  AgentDefinitionCapabilityConfig,
  MaisterYamlV2,
} from "@/lib/config.schema";
import type { PlatformMcpCapability } from "@/lib/capabilities/types";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path, { dirname, join } from "node:path";
import { promisify } from "node:util";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import { ADAPTER_IDS } from "@/lib/acp-runners/adapter-support";
import { upsertCapabilitiesFromConfig } from "@/lib/capabilities/catalog";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  flowIdSchema,
  sourceUrlSchema,
  systemCapabilityCachePath,
  versionTagSchema,
} from "@/lib/flow-paths";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { capabilityImports } = schemaModule as unknown as Record<string, any>;

const execFileAsync = promisify(execFile);

const log = pino({
  name: "capability-import",
  level: process.env.LOG_LEVEL ?? "info",
});

const CLONE_TIMEOUT_MS = 120_000;
const SETUP_SH_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;
const LOCAL_REVISION_LEN = 40;
const SETUP_DONE_SENTINEL = ".maister-setup-done";

// ADR-088: validate a package-supplied revision override at this sink's
// invariant (40-hex) before it reaches systemCapabilityCachePath. Mirrors
// flows.ts parseRevisionOverride.
const CAPABILITY_REVISION_OVERRIDE = /^[0-9a-f]{40}$/;

function parseCapabilityRevisionOverride(
  override: string | undefined,
  capabilityRefId: string,
): string | undefined {
  if (override === undefined) return undefined;

  if (!CAPABILITY_REVISION_OVERRIDE.test(override)) {
    throw new MaisterError(
      "FLOW_INSTALL",
      `Invalid resolvedRevisionOverride for capability "${capabilityRefId}": must be a 40-char hex revision`,
    );
  }

  log.debug(
    { capabilityRefId, override: override.slice(0, 12) },
    "revision override applied (package sub-install)",
  );

  return override;
}

// First 40 hex chars of a simple sha256 of the source string — used as the
// content-addressed identity for local sources that have no git history.
async function localSourceRevision(source: string): Promise<string> {
  const { createHash } = await import("node:crypto");

  return createHash("sha256")
    .update(source, "utf8")
    .digest("hex")
    .slice(0, LOCAL_REVISION_LEN);
}

export type InstalledCapabilityRevision = {
  importRowId: string;
  resolvedRevision: string;
  installedPath: string;
  trustStatus: TrustStatus;
  setupStatus: "not_required" | "pending" | "done" | "failed";
};

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function wrapStage(opts: {
  source: string;
  version: string;
  stage: string;
  message: string;
  cause?: unknown;
}): MaisterError {
  return new MaisterError(
    "FLOW_INSTALL",
    `capability install failed [stage=${opts.stage}] ${opts.source}@${opts.version}: ${opts.message}`,
    opts.cause ? { cause: asError(opts.cause) } : undefined,
  );
}

function buildExecSignal(
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  if (!userSignal) return timeoutSignal;

  return AbortSignal.any([userSignal, timeoutSignal]);
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

function isLocalSource(source: string): boolean {
  return source.startsWith("file://") || path.isAbsolute(source);
}

function trustedCapabilityPrefixes(): string[] {
  return (process.env.MAISTER_TRUSTED_CAPABILITY_SOURCE_PREFIXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Resolve install-time trust for a capability import source (ADR-042). Mirrors
// the Flow-package policy (web/lib/flows/trust.ts) but reads the dedicated
// MAISTER_TRUSTED_CAPABILITY_SOURCE_PREFIXES env so capability and flow trust
// policies are independently configurable:
//   - local/file:// sources are trusted by policy (operator-owned tree);
//   - git sources whose URL starts with a configured prefix are trusted;
//   - everything else is untrusted until an explicit per-import confirmation
//     (POST /api/projects/:slug/capabilities/:refId/trust).
export function resolveCapabilityTrust(source: string): TrustStatus {
  if (isLocalSource(source)) return "trusted_by_policy";

  for (const prefix of trustedCapabilityPrefixes()) {
    if (source.startsWith(prefix)) return "trusted_by_policy";
  }

  return "untrusted";
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

    throw wrapStage({
      source: opts.source,
      version: opts.version,
      stage: "clone",
      message: `command="git clone --branch ${opts.version} --depth 1 ${opts.source}" exitStatus=${e.code ?? "unknown"}${detail}`,
      cause: err,
    });
  }
}

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
    throw wrapStage({
      source: opts.source,
      version: opts.version,
      stage: "resolve-revision",
      message: `git rev-parse HEAD failed in ${opts.dir}: ${asError(err).message}`,
      cause: err,
    });
  }
}

// Low-level setup.sh runner. Returns the resulting setupStatus.
// A non-zero exit returns "failed" (the caller marks the import Failed).
// NEVER call this from installCapabilityRevision — trust must be confirmed first.
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
      { target: opts.target },
      "setup.sh sentinel present, skipping (once-only semantic)",
    );

    return "done";
  }

  log.info({ setupPath }, "running capability setup.sh");

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
      throw new MaisterError(
        "FLOW_INSTALL",
        `capability setup.sh aborted for ${setupPath}`,
        { cause: e },
      );
    }

    log.warn(
      { err: e.message, stderr: e.stderr, setupPath },
      "setup.sh non-zero exit; import marked setup_status=failed",
    );

    return "failed";
  }
}

// Validate the refId and version fields on the boundary (R-PATH, ADR-042).
// Throws FLOW_INSTALL on any violation.
function validateImportBoundary(opts: {
  capabilityRefId: string;
  version: string;
  source: string;
}): void {
  const checks: Array<
    [ReturnType<(typeof flowIdSchema)["safeParse"]>, string]
  > = [
    [flowIdSchema.safeParse(opts.capabilityRefId), "capabilityRefId"],
    [versionTagSchema.safeParse(opts.version), "version"],
    [sourceUrlSchema.safeParse(opts.source), "source"],
  ];

  for (const [parsed, name] of checks) {
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => i.message).join("; ");

      throw new MaisterError("FLOW_INSTALL", `Invalid ${name}: ${msg}`);
    }
  }
}

// Phase-1 of the two-phase install: ensure a durable capability_imports intent
// row. Returns the row id plus whether the revision is already fully Installed
// (idempotent short-circuit). Mirrors ensureRevisionIntentRow from flows.ts.
async function ensureCapabilityImportRow(opts: {
  db: any;
  projectId: string;
  capabilityRefId: string;
  source: string;
  version: string;
  resolvedRevision: string;
  installedPath: string;
}): Promise<{ importRowId: string; skipFinalize: boolean }> {
  const intent = {
    id: randomUUID(),
    projectId: opts.projectId,
    capabilityRefId: opts.capabilityRefId,
    source: opts.source,
    versionTag: opts.version,
    resolvedRevision: opts.resolvedRevision,
    // Placeholder digest — the real digest is written in the finalize step once
    // files are on disk. If we crash here the row stays Installing and is reset
    // on retry.
    manifestDigest: "pending",
    manifest: {},
    installedPath: opts.installedPath,
    packageStatus: "Installing" as const,
    setupStatus: "pending" as const,
    trustStatus: "untrusted" as const,
  };

  const inserted: Array<{ id: string }> = await opts.db
    .insert(capabilityImports)
    .values(intent)
    .onConflictDoNothing({
      target: [
        capabilityImports.projectId,
        capabilityImports.capabilityRefId,
        capabilityImports.resolvedRevision,
      ],
    })
    .returning({ id: capabilityImports.id });

  if (inserted[0]?.id) {
    return { importRowId: inserted[0].id, skipFinalize: false };
  }

  // Conflict: a row already exists for (projectId, capabilityRefId, resolvedRevision).
  const existing: Array<{ id: string; packageStatus: string }> = await opts.db
    .select({
      id: capabilityImports.id,
      packageStatus: capabilityImports.packageStatus,
    })
    .from(capabilityImports)
    .where(
      and(
        eq(capabilityImports.projectId, opts.projectId),
        eq(capabilityImports.capabilityRefId, opts.capabilityRefId),
        eq(capabilityImports.resolvedRevision, opts.resolvedRevision),
      ),
    );

  const row = existing[0];

  if (!row) {
    throw new MaisterError(
      "FLOW_INSTALL",
      `capability import row vanished for ${opts.capabilityRefId}@${opts.resolvedRevision}`,
    );
  }

  const onDisk = await pathExists(opts.installedPath);

  if (row.packageStatus === "Installed" && onDisk) {
    return { importRowId: row.id, skipFinalize: true };
  }

  // A previous attempt left the row Failed/Installing, or the cache is gone.
  // Reset to Installing and re-run finalize.
  await opts.db
    .update(capabilityImports)
    .set({ packageStatus: "Installing" })
    .where(eq(capabilityImports.id, row.id));

  return { importRowId: row.id, skipFinalize: false };
}

// Install a capability bundle revision into the global content-addressed cache
// and record an immutable capability_imports row (two-phase).
//
// SECURITY (ADR-042): NEVER execute setup.sh here — that would run arbitrary
// code from a possibly-untrusted source before any trust decision. The row
// records setupStatus `not_required` (no setup.sh) or `pending` (deferred).
// setup.sh runs only after trust is confirmed, via runCapabilityRevisionSetup.
export async function installCapabilityRevision(opts: {
  source: string;
  version: string;
  capabilityRefId: string;
  projectId: string;
  // ADR-088: package sub-installs inherit the package's resolved revision
  // (tag SHA or package content digest); see flows.ts resolvedRevisionOverride.
  resolvedRevisionOverride?: string;
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
  signal?: AbortSignal;
}): Promise<InstalledCapabilityRevision> {
  const { source, version, capabilityRefId, projectId, signal } = opts;
  const db = opts.db ?? getDb();

  validateImportBoundary({ capabilityRefId, version, source });

  const revisionOverride = parseCapabilityRevisionOverride(
    opts.resolvedRevisionOverride,
    capabilityRefId,
  );

  let resolvedRevision: string;
  let target: string;
  let tmpDir: string | null = null;
  let manifest: Record<string, unknown> = {};

  if (isLocalSource(source)) {
    const absSource = source.startsWith("file://")
      ? source.slice("file://".length)
      : source;

    resolvedRevision =
      revisionOverride ?? (await localSourceRevision(absSource));
    target = systemCapabilityCachePath(capabilityRefId, resolvedRevision);
  } else {
    tmpDir = await mkdtemp(
      path.join(os.tmpdir(), `maister-cap-clone-${capabilityRefId}-`),
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
      target = systemCapabilityCachePath(capabilityRefId, resolvedRevision);
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  log.info(
    { capabilityRefId, version, source, resolvedRevision },
    "installing capability revision",
  );

  const { importRowId, skipFinalize } = await ensureCapabilityImportRow({
    db,
    projectId,
    capabilityRefId,
    source,
    version,
    resolvedRevision,
    installedPath: target,
  });

  try {
    if (skipFinalize) {
      if (tmpDir)
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      log.info(
        { target, resolvedRevision },
        "capability revision already Installed; reusing cache",
      );

      const row: Array<{
        setupStatus: InstalledCapabilityRevision["setupStatus"];
        trustStatus: string;
      }> = await db
        .select({
          setupStatus: capabilityImports.setupStatus,
          trustStatus: capabilityImports.trustStatus,
        })
        .from(capabilityImports)
        .where(eq(capabilityImports.id, importRowId));

      const trustStatus =
        (row[0]?.trustStatus as TrustStatus | undefined) ?? "untrusted";

      return {
        importRowId,
        resolvedRevision,
        installedPath: target,
        trustStatus,
        setupStatus: row[0]?.setupStatus ?? "not_required",
      };
    }

    const cachePopulated = await pathExists(target);

    if (!cachePopulated) {
      await mkdir(dirname(target), { recursive: true });

      if (isLocalSource(source)) {
        const absSource = source.startsWith("file://")
          ? source.slice("file://".length)
          : source;

        await cp(absSource, target, {
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

    // Attempt to read a manifest file if present; store {} otherwise.
    // Capability bundles may not have a canonical manifest format yet —
    // the digest is over the resolved revision string for now.
    const { createHash } = await import("node:crypto");
    const manifestDigest = createHash("sha256")
      .update(resolvedRevision, "utf8")
      .digest("hex");

    // SECURITY (ADR-042): NEVER execute setup.sh during install — that would
    // run arbitrary code from a possibly-untrusted source. The row records
    // setupStatus `not_required` (no setup.sh) or `pending` (deferred).
    // setup.sh runs only after trust is confirmed, via runCapabilityRevisionSetup.
    const setupStatus: InstalledCapabilityRevision["setupStatus"] =
      (await pathExists(join(target, "setup.sh"))) ? "pending" : "not_required";

    const trustStatus = resolveCapabilityTrust(source);

    await db
      .update(capabilityImports)
      .set({
        packageStatus: "Installed",
        setupStatus,
        trustStatus,
        manifest,
        manifestDigest,
        updatedAt: new Date(),
      })
      .where(eq(capabilityImports.id, importRowId));

    log.info(
      {
        capabilityRefId,
        importRowId,
        resolvedRevision,
        target,
        setupStatus,
        trustStatus,
      },
      "capability revision install complete (setup deferred until trust confirmed)",
    );

    return {
      importRowId,
      resolvedRevision,
      installedPath: target,
      trustStatus,
      setupStatus,
    };
  } catch (err) {
    await db
      .update(capabilityImports)
      .set({ packageStatus: "Failed" })
      .where(eq(capabilityImports.id, importRowId))
      .catch(() => {});
    if (tmpDir)
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});

    if (err instanceof MaisterError) throw err;
    throw wrapStage({
      source,
      version,
      stage: "finalize",
      message: asError(err).message,
      cause: err,
    });
  }
}

// Execute a capability bundle's setup.sh AFTER trust is confirmed (ADR-042).
// Idempotent via the once-only sentinel. Runs ONLY when:
//   - trustStatus ∈ {trusted, trusted_by_policy}
//   - setupStatus ∈ {pending, failed}  (retryable)
// done / not_required → no-op. On success → setupStatus='done'; on non-zero/
// throw → setupStatus='failed' (retryable). Callers MUST have established
// trust first — installCapabilityRevision never runs setup.
export async function runCapabilityRevisionSetup(opts: {
  importRowId: string;
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
  signal?: AbortSignal;
}): Promise<{ setupStatus: "not_required" | "done" | "failed" | "pending" }> {
  const { importRowId, signal } = opts;
  const db = opts.db ?? getDb();

  const rows: Array<{
    trustStatus: string;
    setupStatus: string;
    installedPath: string;
  }> = await db
    .select({
      trustStatus: capabilityImports.trustStatus,
      setupStatus: capabilityImports.setupStatus,
      installedPath: capabilityImports.installedPath,
    })
    .from(capabilityImports)
    .where(eq(capabilityImports.id, importRowId));

  const row = rows[0];

  if (!row) {
    throw new MaisterError(
      "FLOW_INSTALL",
      `capability import row not found: ${importRowId}`,
    );
  }

  const { trustStatus, setupStatus, installedPath } = row;

  // Only trusted rows may run setup.sh (ADR-042).
  if (trustStatus !== "trusted" && trustStatus !== "trusted_by_policy") {
    log.info(
      { importRowId, trustStatus },
      "runCapabilityRevisionSetup: refusing setup.sh for untrusted import",
    );

    return {
      setupStatus: setupStatus as
        | "not_required"
        | "done"
        | "failed"
        | "pending",
    };
  }

  // No-op for terminal states.
  if (setupStatus === "done" || setupStatus === "not_required") {
    log.debug(
      { importRowId, setupStatus },
      "runCapabilityRevisionSetup: no-op (already terminal)",
    );

    return {
      setupStatus: setupStatus as "not_required" | "done",
    };
  }

  // Only pending/failed are retryable.
  if (setupStatus !== "pending" && setupStatus !== "failed") {
    return { setupStatus: "pending" };
  }

  log.info(
    { importRowId, installedPath },
    "running capability setup.sh (trust confirmed)",
  );

  const newSetupStatus = await runSetupSh({ target: installedPath, signal });

  await db
    .update(capabilityImports)
    .set({
      setupStatus: newSetupStatus,
      ...(newSetupStatus === "failed" ? { packageStatus: "Failed" } : {}),
      updatedAt: new Date(),
    })
    .where(eq(capabilityImports.id, importRowId));

  log.info(
    { importRowId, setupStatus: newSetupStatus },
    "capability revision setup run",
  );

  return { setupStatus: newSetupStatus };
}

// Install every `maister.yaml capability_imports[]` entry (fetch → trust →
// trust-gated setup) and ingest the resolved set into `capability_records`
// alongside the project's `capabilities` block, in ONE SET/CLEAR upsert. This
// runs in project-register phase (d) — AFTER the project row is committed and
// AFTER flow install — because each import is a git-clone side-effect that
// cannot live inside the project transaction and the records FK the project.
//
// R-SYM: removing an import from `capability_imports[]` drops its
// `agent_definition` entry from the upsert's desired set, so the CLEAR sweep
// disables the stale `capability_records` row.
//
// Each opaque import package becomes one `agent_definition` capability_record
// (source `flow-package`). The package's internal kind is unknown without a
// manifest; the launch-time ref check (buildCapabilityRefIds) accepts the id
// for any node settings kind.
export async function installAndIngestCapabilityImports(opts: {
  config: MaisterYamlV2;
  projectId: string;
  platformMcps?: PlatformMcpCapability[];
  // ADR-088: package-derived agent_definition entries (installed by
  // installPackage) folded into the SAME SET/CLEAR upsert so config + import
  // + package records stay one symmetric write.
  additionalImportDerived?: AgentDefinitionCapabilityConfig[];
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
  signal?: AbortSignal;
}): Promise<void> {
  const db = opts.db ?? getDb();
  const importDerived: AgentDefinitionCapabilityConfig[] = [
    ...(opts.additionalImportDerived ?? []),
  ];

  for (const entry of opts.config.capability_imports) {
    const installed = await installCapabilityRevision({
      source: entry.source,
      version: entry.version,
      capabilityRefId: entry.id,
      projectId: opts.projectId,
      db,
      signal: opts.signal,
    });

    // Auto-trusted (policy/local) sources run setup now; `trust: explicit`
    // defers setup to the operator trust-confirm route (T2.5).
    if (entry.trust !== "explicit") {
      await runCapabilityRevisionSetup({
        importRowId: installed.importRowId,
        db,
        signal: opts.signal,
      });
    }

    importDerived.push({
      id: entry.id,
      kind: "agent_definition",
      label: entry.id,
      source: "flow-package",
      version: entry.version,
      revision: installed.resolvedRevision,
      agents: [...ADAPTER_IDS],
      enforceability: "instructed",
      selected_by_default: true,
    });

    log.debug(
      {
        refId: entry.id,
        sha: installed.resolvedRevision.slice(0, 12),
        trust: installed.trustStatus,
        setupStatus: installed.setupStatus,
      },
      "capability import resolved",
    );
  }

  await upsertCapabilitiesFromConfig({
    projectId: opts.projectId,
    config: {
      ...opts.config.capabilities,
      agent_definitions: [
        ...opts.config.capabilities.agent_definitions,
        ...importDerived,
      ],
    },
    platformMcps: opts.platformMcps,
    db,
  });
}

// Operator-confirmed trust for a capability import, then run its setup.sh
// (ADR-042, R-2PC retry-safe). Two phases around the side-effect:
//   Phase 1 (tx, SELECT FOR UPDATE): claim trust on the operative installed
//     revision. The idempotency marker is `setupStatus` (NOT `trustStatus`) —
//     a re-POST after a setup failure MUST re-run setup, so the 409 fires ONLY
//     when setupStatus ∈ {done, not_required} (genuinely nothing to do).
//   Phase 2 (outside the tx): runCapabilityRevisionSetup runs the script and
//     writes setupStatus (the AFTER marker). A non-zero exit → FLOW_INSTALL
//     (502, retryable) per ADR-042 — NOT EXECUTOR_UNAVAILABLE.
export async function confirmCapabilityTrust(opts: {
  projectId: string;
  capabilityRefId: string;
  // FIXME(any): dual drizzle-orm peer-dep variants.
  db?: any;
  signal?: AbortSignal;
}): Promise<{ trustStatus: "trusted"; setupStatus: string }> {
  const db = opts.db ?? getDb();

  const importRowId: string = await db.transaction(async (tx: any) => {
    const rows: Array<{ id: string; setupStatus: string }> = await tx
      .select({
        id: capabilityImports.id,
        setupStatus: capabilityImports.setupStatus,
      })
      .from(capabilityImports)
      .where(
        and(
          eq(capabilityImports.projectId, opts.projectId),
          eq(capabilityImports.capabilityRefId, opts.capabilityRefId),
        ),
      )
      // Most-recent revision is the operative one. NOT filtered on
      // packageStatus: a prior setup failure leaves the row packageStatus
      // 'Failed' (T2.3) yet setupStatus 'failed' is the retryable marker — the
      // re-confirm MUST still find it.
      .orderBy(desc(capabilityImports.createdAt))
      .for("update");

    const row = rows[0];

    if (!row) {
      throw new MaisterError(
        "PRECONDITION",
        `capability import not found for "${opts.capabilityRefId}"`,
      );
    }

    if (row.setupStatus === "done" || row.setupStatus === "not_required") {
      throw new MaisterError(
        "CONFLICT",
        `capability "${opts.capabilityRefId}" trust already confirmed (setup ${row.setupStatus})`,
      );
    }

    await tx
      .update(capabilityImports)
      .set({ trustStatus: "trusted", updatedAt: new Date() })
      .where(eq(capabilityImports.id, row.id));

    return row.id;
  });

  const { setupStatus } = await runCapabilityRevisionSetup({
    importRowId,
    db,
    signal: opts.signal,
  });

  if (setupStatus === "failed") {
    throw new MaisterError(
      "FLOW_INSTALL",
      `capability "${opts.capabilityRefId}" setup.sh failed after trust confirmation (retryable)`,
    );
  }

  log.info(
    { importRowId, refId: opts.capabilityRefId, setupStatus },
    "capability trust confirmed",
  );

  return { trustStatus: "trusted", setupStatus };
}
