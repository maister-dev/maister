import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readlink,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path, { dirname, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import pino from "pino";

import { loadFlowManifest } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  flowIdSchema,
  projectFlowSymlinkPath,
  projectSlugSchema,
  sourceUrlSchema,
  systemCachePath,
  versionTagSchema,
} from "@/lib/flow-paths";

// FIXME(any): dual drizzle-orm peer-dep variants (see schema.integration.test.ts).
const { flows } = schemaModule as unknown as Record<string, any>;

const execFileAsync = promisify(execFile);

const log = pino({
  name: "flows",
  level: process.env.LOG_LEVEL ?? "info",
});

const CLONE_TIMEOUT_MS = 120_000;
const SETUP_SH_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

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
  flowRowId: string;
  installedPath: string;
  symlinkPath: string;
  manifest: FlowYamlV1;
};

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function wrapInstall(message: string, cause: unknown): MaisterError {
  return new MaisterError("FLOW_INSTALL", message, { cause: asError(cause) });
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
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const detail = e.stderr ? `: ${e.stderr.trim()}` : "";

    throw wrapInstall(
      `git clone failed for ${opts.source}@${opts.version}${detail}`,
      err,
    );
  }
}

async function ensureSymlink(opts: {
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

async function runSetupSh(opts: {
  target: string;
  signal?: AbortSignal;
}): Promise<void> {
  const setupPath = join(opts.target, "setup.sh");

  if (!(await pathExists(setupPath))) {
    log.debug({ target: opts.target }, "no setup.sh, skipping");

    return;
  }

  const sentinelPath = join(opts.target, SETUP_DONE_SENTINEL);

  if (await pathExists(sentinelPath)) {
    log.debug(
      { target: opts.target, sentinelPath },
      "setup.sh sentinel present, skipping (once-only semantic)",
    );

    return;
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
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };

    if (e.name === "AbortError") {
      log.info({ setupPath }, "setup.sh aborted by signal");

      throw wrapInstall(`setup.sh aborted for ${setupPath}`, err);
    }

    log.warn(
      { err: e.message, stderr: e.stderr, setupPath },
      "setup.sh non-zero exit; install continues (POC trusts internal sources)",
    );
  }
}

async function upsertFlowRow(opts: {
  // FIXME(any): see InstallFlowPluginArgs.db
  db: any;
  projectId: string;
  flowId: string;
  source: string;
  version: string;
  installedPath: string;
  manifest: FlowYamlV1;
}): Promise<string> {
  const id = randomUUID();
  const recommendedExecutorId = opts.manifest.recommended_executor ?? null;

  try {
    const rows = await opts.db
      .insert(flows)
      .values({
        id,
        projectId: opts.projectId,
        flowRefId: opts.flowId,
        source: opts.source,
        version: opts.version,
        installedPath: opts.installedPath,
        manifest: opts.manifest,
        schemaVersion: opts.manifest.schemaVersion,
        recommendedExecutorId,
      })
      .onConflictDoUpdate({
        target: [flows.projectId, flows.flowRefId],
        set: {
          source: opts.source,
          version: opts.version,
          installedPath: opts.installedPath,
          manifest: opts.manifest,
          schemaVersion: opts.manifest.schemaVersion,
          recommendedExecutorId,
        },
      })
      .returning({ id: flows.id });

    const rowId = rows[0]?.id;

    if (!rowId) {
      throw new Error("db upsert returned no row");
    }

    log.info(
      { flowRowId: rowId, flowRefId: opts.flowId, version: opts.version },
      "upserted flow row",
    );

    return rowId;
  } catch (err) {
    throw wrapInstall(
      `db upsert failed for flow ${opts.flowId}@${opts.version}`,
      err,
    );
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

async function installFlowPluginImpl(
  args: InstallFlowPluginArgs,
): Promise<InstallResult> {
  const { source, version, projectId, projectSlug, flowId, signal } = args;
  const workspaceRoot = args.workspaceRoot ?? process.cwd();
  const db = args.db ?? getDb();
  const target = systemCachePath(flowId, version);

  log.info({ flowId, version, source, target }, "installing flow plugin");

  const alreadyInstalled =
    (await pathExists(target)) && (await pathExists(join(target, "flow.yaml")));

  if (alreadyInstalled) {
    log.info({ target }, "skip clone (already installed)");
  } else {
    const sourceKind = await isLocalDirectorySource(source);

    await mkdir(dirname(target), { recursive: true });

    if (sourceKind.kind === "local") {
      log.info(
        { absPath: sourceKind.absPath, target },
        "local-source-detected",
      );
      await cp(sourceKind.absPath, target, {
        recursive: true,
        errorOnExist: false,
        force: false,
      });
      log.info({ target }, "local-copy-done");
    } else {
      await gitClone({ source, version, target, signal });
    }
  }

  let manifest: FlowYamlV1;

  try {
    manifest = await loadFlowManifest(join(target, "flow.yaml"));
  } catch (err) {
    throw wrapInstall(
      `flow.yaml invalid in ${target}: ${(err as Error).message}`,
      err,
    );
  }

  await runSetupSh({ target, signal });

  const symlinkPath = projectFlowSymlinkPath(
    workspaceRoot,
    projectSlug,
    flowId,
  );

  await ensureSymlink({ target, linkPath: symlinkPath });
  log.info({ symlinkPath }, "symlink ready");

  const flowRowId = await upsertFlowRow({
    db,
    projectId,
    flowId,
    source,
    version,
    installedPath: target,
    manifest,
  });

  log.info(
    { flowId, version, flowRowId, target, symlinkPath },
    "flow plugin install complete",
  );

  return { flowRowId, installedPath: target, symlinkPath, manifest };
}

export async function installFlowPlugin(
  args: InstallFlowPluginArgs,
): Promise<InstallResult> {
  validateBoundary(args);

  // Dedup key includes projectId so concurrent installs of the same flow tag
  // to DIFFERENT projects each run their own per-project pipeline (symlink +
  // DB upsert). Filesystem-level idempotency in pathExists() prevents the
  // git clone itself from running twice when the system cache already exists.
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
