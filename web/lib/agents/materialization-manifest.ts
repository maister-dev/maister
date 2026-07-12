import "server-only";

import { lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import {
  releaseMaterializationLock,
  tryAcquireMaterializationLock,
} from "@/lib/agents/materialization-lock";
import { atomicWriteJson } from "@/lib/atomic";
import { MaisterError } from "@/lib/errors";

export const AGENT_MATERIALIZATION_ROOT_RELATIVE =
  ".maister/agent-materialization";
export const PACKAGE_SKILLS_MANIFEST_RELATIVE =
  AGENT_MATERIALIZATION_ROOT_RELATIVE;

const INDEX_FILE = "index.json";
const RUNS_DIR = "runs";
const LOCK_WAIT_MS = 2_000;
const ALLOWED_ROOTS = [
  ".claude/skills",
  ".claude/agents",
  ".gemini/skills",
  ".maister/capabilities",
] as const;
const ALLOWED_FILES = [
  ".claude/settings.local.json",
  ".claude/settings.local.json.maister-owned",
  ".claude/settings.local.json.maister-bak",
  ".claude/settings.local.json.maister-operation",
] as const;

const log = pino({
  name: "agent-materialization",
  level: process.env.LOG_LEVEL ?? "info",
});

export type AgentMaterializationState = "preparing" | "active" | "releasing";

export type AgentMaterializationRunRecord = {
  readonly version: 1;
  readonly runId: string;
  readonly state: AgentMaterializationState;
  readonly paths: readonly string[];
};

export type AgentMaterializationIndex = {
  readonly version: 1;
  readonly leases: Readonly<Record<string, readonly string[]>>;
};

export type PackageSkillsManifest = AgentMaterializationIndex;

function isMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { readonly code?: unknown }).code === "ENOENT"
  );
}

function rootPath(cwd: string): string {
  return path.join(cwd, AGENT_MATERIALIZATION_ROOT_RELATIVE);
}

function indexPath(cwd: string): string {
  return path.join(rootPath(cwd), INDEX_FILE);
}

function assertRunId(runId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.includes("..")) {
    throw new MaisterError(
      "CONFIG",
      `invalid materialization run id: ${runId}`,
    );
  }

  return runId;
}

function runRecordPath(cwd: string, runId: string): string {
  return path.join(rootPath(cwd), RUNS_DIR, `${assertRunId(runId)}.json`);
}

export function normalizeAgentMaterializationPath(value: string): string {
  if (
    value.length === 0 ||
    value.endsWith("/") ||
    value.includes("\\") ||
    path.isAbsolute(value) ||
    value !== path.posix.normalize(value)
  ) {
    throw new MaisterError(
      "CONFIG",
      `invalid agent materialization path: ${value || "<empty>"}`,
    );
  }

  const parts = value.split("/");

  if (parts.includes(".") || parts.includes("..")) {
    throw new MaisterError(
      "CONFIG",
      `unsafe agent materialization path: ${value}`,
    );
  }

  const allowed =
    ALLOWED_FILES.includes(value as (typeof ALLOWED_FILES)[number]) ||
    ALLOWED_ROOTS.some(
      (root) => value.startsWith(`${root}/`) && value.length > root.length + 1,
    );

  if (!allowed) {
    throw new MaisterError(
      "CONFIG",
      `agent materialization path is outside adapter roots: ${value}`,
    );
  }

  return value;
}

function normalizeDistinctPaths(paths: readonly string[]): string[] {
  const normalized = paths.map(normalizeAgentMaterializationPath);

  if (new Set(normalized).size !== normalized.length) {
    throw new MaisterError(
      "CONFIG",
      "agent materialization record contains duplicate paths",
    );
  }

  return normalized;
}

function parseIndex(value: unknown): AgentMaterializationIndex {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("leases" in value) ||
    typeof value.leases !== "object" ||
    value.leases === null ||
    Array.isArray(value.leases)
  ) {
    throw new MaisterError("CONFIG", "agent materialization index is corrupt");
  }

  const leases: Record<string, readonly string[]> = {};

  for (const [rawPath, rawOwners] of Object.entries(value.leases)) {
    const relativePath = normalizeAgentMaterializationPath(rawPath);

    if (
      !Array.isArray(rawOwners) ||
      rawOwners.length === 0 ||
      rawOwners.some((owner) => typeof owner !== "string") ||
      new Set(rawOwners).size !== rawOwners.length
    ) {
      throw new MaisterError(
        "CONFIG",
        `agent materialization leases are corrupt for ${relativePath}`,
      );
    }
    leases[relativePath] = rawOwners as string[];
  }

  return { version: 1, leases };
}

async function readIndex(cwd: string): Promise<AgentMaterializationIndex> {
  await assertNoSymlinkComponents(
    cwd,
    `${AGENT_MATERIALIZATION_ROOT_RELATIVE}/${INDEX_FILE}`,
  );

  try {
    return parseIndex(JSON.parse(await readFile(indexPath(cwd), "utf8")));
  } catch (err) {
    if (isMissing(err)) return { version: 1, leases: {} };
    if (err instanceof MaisterError) throw err;
    throw new MaisterError(
      "CONFIG",
      `agent materialization index cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function assertNoSymlinkComponents(
  cwd: string,
  relativePath: string,
): Promise<boolean> {
  const segments = relativePath.split("/").filter(Boolean);
  let current = cwd;

  try {
    const cwdMetadata = await lstat(cwd);

    if (cwdMetadata.isSymbolicLink() || !cwdMetadata.isDirectory()) {
      throw new MaisterError(
        "CONFIG",
        `agent materialization cwd is unsafe: ${cwd}`,
      );
    }
  } catch (err) {
    if (isMissing(err)) {
      throw new MaisterError(
        "CONFIG",
        `agent materialization cwd does not exist: ${cwd}`,
      );
    }
    throw err;
  }

  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new MaisterError(
          "CONFIG",
          `refusing agent materialization through symlinked path component: ${path.relative(cwd, current)}`,
        );
      }
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
  }

  return true;
}

async function resolveSafeMaterializationCwd(
  cwdInput: string,
): Promise<string> {
  const cwd = path.resolve(cwdInput);

  await assertNoSymlinkComponents(cwd, "");

  // Resolve any ancestor aliases once and keep every subsequent metadata read
  // and mutation anchored to that physical directory. Node core has no dirfd /
  // openat API for a total hostile-worktree TOCTOU guarantee, so each owned
  // path is still rechecked immediately before use below.
  return realpath(cwd);
}

/**
 * Verifies that a worktree and every existing component leading to a known
 * MAIster-owned path are real directories/files, never symlinks. Callers that
 * write other run-scoped artifacts reuse this before and after creating parent
 * directories so direct writers cannot bypass the ownership path fence.
 */
export async function assertSafeAgentMaterializationPath(
  cwdInput: string,
  relativePath: string,
): Promise<string> {
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath !== path.posix.normalize(relativePath) ||
    relativePath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new MaisterError(
      "CONFIG",
      `unsafe agent materialization path component: ${relativePath}`,
    );
  }

  const cwd = await resolveSafeMaterializationCwd(cwdInput);

  await assertNoSymlinkComponents(cwd, relativePath);

  return cwd;
}

async function withLock<T>(cwd: string, effect: () => Promise<T>): Promise<T> {
  const materializationRoot = rootPath(cwd);
  const deadline = Date.now() + LOCK_WAIT_MS;

  await assertNoSymlinkComponents(cwd, AGENT_MATERIALIZATION_ROOT_RELATIVE);
  await mkdir(materializationRoot, { recursive: true });
  await assertNoSymlinkComponents(cwd, AGENT_MATERIALIZATION_ROOT_RELATIVE);
  await assertNoSymlinkComponents(
    cwd,
    `${AGENT_MATERIALIZATION_ROOT_RELATIVE}/${RUNS_DIR}`,
  );

  for (;;) {
    const handle = await tryAcquireMaterializationLock(materializationRoot);

    if (handle) {
      try {
        return await effect();
      } finally {
        await releaseMaterializationLock(handle);
      }
    }

    if (Date.now() >= deadline) {
      throw new MaisterError(
        "CONFLICT",
        `timed out waiting for agent materialization lock in ${cwd}`,
      );
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Runs a small cross-writer critical section under the same per-cwd SQLite
 * mutex as lease materialization. Use this for owned artifacts whose cleanup
 * semantics need more than a simple recursive remove (for example restoring a
 * pre-existing settings file from its backup).
 */
export async function withAgentMaterializationLock<T>(
  cwdInput: string,
  effect: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = await resolveSafeMaterializationCwd(cwdInput);

  return withLock(cwd, () => effect(cwd));
}

export async function materializeWithAgentLease(args: {
  readonly cwd: string;
  readonly runId: string;
  readonly materialize: (
    ownedPaths: ReadonlySet<string>,
    recordIntent: (absolutePaths: readonly string[]) => Promise<void>,
    ownedByRunPaths: ReadonlySet<string>,
  ) => Promise<readonly string[]>;
}): Promise<string[]> {
  const cwd = await resolveSafeMaterializationCwd(args.cwd);

  return withLock(cwd, async () => {
    const index = await readIndex(cwd);
    const ownedByRunPaths = new Set(
      Object.entries(index.leases)
        .filter(([, owners]) => owners.includes(args.runId))
        .map(([relativePath]) => relativePath),
    );
    let existing = await readRunRecord(cwd, args.runId);

    if (existing?.state === "releasing") {
      throw new MaisterError(
        "CONFLICT",
        `agent materialization run ${args.runId} is releasing`,
      );
    }

    if (existing?.state === "preparing") {
      const committedPaths = existing.paths.filter((relativePath) =>
        index.leases[relativePath]?.includes(args.runId),
      );
      const ambiguousPathCount = existing.paths.length - committedPaths.length;

      existing = {
        ...existing,
        state: "active",
        paths: committedPaths,
      };
      log.warn(
        {
          runId: args.runId,
          cwd,
          ownershipState: "preparing_recovered",
          ambiguousPathCount,
        },
        "recovered interrupted agent materialization intent without deleting uncommitted paths",
      );
    }

    const preparing: AgentMaterializationRunRecord = {
      version: 1,
      runId: assertRunId(args.runId),
      state: "preparing",
      paths: existing?.paths ?? [],
    };

    await atomicWriteJson(runRecordPath(cwd, args.runId), preparing);

    let currentIntent = preparing;
    const recordIntent = async (absolutePaths: readonly string[]) => {
      const intendedPaths = normalizeDistinctPaths(
        absolutePaths.map((absolutePath) => path.relative(cwd, absolutePath)),
      );

      for (const relativePath of intendedPaths) {
        await assertNoSymlinkComponents(cwd, relativePath);
      }
      const nextIntent: AgentMaterializationRunRecord = {
        ...currentIntent,
        paths: [...new Set([...currentIntent.paths, ...intendedPaths])],
      };

      await atomicWriteJson(runRecordPath(cwd, args.runId), nextIntent);
      currentIntent = nextIntent;
    };
    const absolutePaths = await args.materialize(
      new Set(Object.keys(index.leases)),
      recordIntent,
      ownedByRunPaths,
    );
    const newRelativePaths = normalizeDistinctPaths(
      absolutePaths.map((absolutePath) => path.relative(cwd, absolutePath)),
    );

    for (const relativePath of newRelativePaths) {
      await assertNoSymlinkComponents(cwd, relativePath);
    }
    const relativePaths = [
      ...new Set([...(existing?.paths ?? []), ...newRelativePaths]),
    ];
    const leases: Record<string, readonly string[]> = { ...index.leases };

    for (const relativePath of relativePaths) {
      const owners = leases[relativePath] ?? [];

      leases[relativePath] = owners.includes(args.runId)
        ? owners
        : [...owners, args.runId];
    }

    const active: AgentMaterializationRunRecord = {
      ...preparing,
      state: "active",
      paths: relativePaths,
    };

    await atomicWriteJson(indexPath(cwd), { version: 1, leases });
    await atomicWriteJson(runRecordPath(cwd, args.runId), active);
    log.debug(
      {
        runId: args.runId,
        cwd,
        ownershipState: active.state,
        pathCount: relativePaths.length,
        leaseCount: Object.keys(leases).length,
      },
      "agent materialization lease activated",
    );

    return relativePaths.map((relativePath) => path.join(cwd, relativePath));
  });
}

function parseRunRecord(
  value: unknown,
  runId: string,
): AgentMaterializationRunRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("runId" in value) ||
    value.runId !== runId ||
    !("state" in value) ||
    !["preparing", "active", "releasing"].includes(String(value.state)) ||
    !("paths" in value) ||
    !Array.isArray(value.paths) ||
    value.paths.some((item) => typeof item !== "string")
  ) {
    throw new MaisterError(
      "CONFIG",
      `agent materialization run record is corrupt for ${runId}`,
    );
  }

  return {
    version: 1,
    runId,
    state: value.state as AgentMaterializationState,
    paths: normalizeDistinctPaths(value.paths as string[]),
  };
}

async function readRunRecord(
  cwd: string,
  runId: string,
): Promise<AgentMaterializationRunRecord | null> {
  await assertNoSymlinkComponents(
    cwd,
    `${AGENT_MATERIALIZATION_ROOT_RELATIVE}/${RUNS_DIR}/${assertRunId(runId)}.json`,
  );

  try {
    return parseRunRecord(
      JSON.parse(await readFile(runRecordPath(cwd, runId), "utf8")),
      runId,
    );
  } catch (err) {
    if (isMissing(err)) return null;
    if (err instanceof MaisterError) throw err;
    throw new MaisterError(
      "CONFIG",
      `agent materialization run record cannot be read for ${runId}`,
    );
  }
}

async function assertSafeOwnedTarget(
  cwd: string,
  relativePath: string,
): Promise<boolean> {
  const normalized = normalizeAgentMaterializationPath(relativePath);
  const target = path.join(cwd, normalized);

  await assertNoSymlinkComponents(cwd, normalized);

  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new MaisterError(
        "CONFIG",
        `refusing to remove symlinked materialization target: ${relativePath}`,
      );
    }

    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

export async function releaseAgentMaterialization(
  cwdInput: string,
  runId: string,
  opts: { readonly preservePaths?: readonly string[] } = {},
): Promise<{
  readonly restoredPathCount: number;
  readonly remainingLeaseCount: number;
}> {
  const cwd = await resolveSafeMaterializationCwd(cwdInput);
  const initialRecord = await readRunRecord(cwd, runId);

  if (!initialRecord) {
    return { restoredPathCount: 0, remainingLeaseCount: 0 };
  }

  return withLock(cwd, async () => {
    const record = await readRunRecord(cwd, runId);

    if (!record) return { restoredPathCount: 0, remainingLeaseCount: 0 };

    const index = await readIndex(cwd);
    const leases: Record<string, readonly string[]> = { ...index.leases };
    const removable: string[] = [];
    const preservedPaths = new Set(
      (opts.preservePaths ?? []).map(normalizeAgentMaterializationPath),
    );

    for (const relativePath of record.paths) {
      const owners = leases[relativePath] ?? [];

      if (!owners.includes(runId)) {
        if (record.state === "active") {
          throw new MaisterError(
            "CONFIG",
            `agent materialization lease is missing for ${runId}:${relativePath}`,
          );
        }
        if (
          record.state === "releasing" &&
          owners.length === 0 &&
          (await assertSafeOwnedTarget(cwd, relativePath))
        ) {
          throw new MaisterError(
            "CONFIG",
            `agent materialization releasing target still exists without a lease for ${runId}:${relativePath}`,
          );
        }
        if (record.state === "preparing" && owners.length === 0) {
          if (!preservedPaths.has(relativePath)) {
            // Intent is durable evidence that this run was the only writer
            // allowed to create the path. Roll back its zero-owner crash
            // residue; a foreign non-empty lease is handled below by leaving
            // the path intact.
            removable.push(relativePath);
          }
          continue;
        }
        if (owners.length === 0) {
          log.warn(
            { cwd, runId, relativePath, ownershipState: record.state },
            "preserving materialization path without a committed lease",
          );
        }
        continue;
      }

      const remaining = owners.filter((owner) => owner !== runId);

      if (remaining.length === 0) {
        delete leases[relativePath];
        if (!preservedPaths.has(relativePath)) {
          removable.push(relativePath);
        }
      } else {
        leases[relativePath] = remaining;
      }
    }

    for (const relativePath of removable) {
      await assertSafeOwnedTarget(cwd, relativePath);
    }

    for (const relativePath of removable) {
      await rm(path.join(cwd, relativePath), { recursive: true, force: true });
    }

    await atomicWriteJson(runRecordPath(cwd, runId), {
      ...record,
      state: "releasing",
    });
    await atomicWriteJson(indexPath(cwd), { version: 1, leases });
    await rm(runRecordPath(cwd, runId), { force: true });

    log.info(
      {
        runId,
        cwd,
        ownershipState: "released",
        restoredPathCount: removable.length,
        preservedPathCount: [...preservedPaths].filter(
          (relativePath) => record.paths.includes(relativePath),
        ).length,
        remainingLeaseCount: Object.keys(leases).length,
      },
      "agent materialization lease released",
    );

    return {
      restoredPathCount: removable.length,
      remainingLeaseCount: Object.keys(leases).length,
    };
  });
}

export async function agentMaterializationPathsForRun(
  cwd: string,
  runId: string,
): Promise<string[]> {
  const record = await readRunRecord(
    await resolveSafeMaterializationCwd(cwd),
    runId,
  );

  return record ? [...record.paths] : [];
}

export async function listAgentMaterializationRunIds(
  cwdInput: string,
): Promise<string[]> {
  const cwd = await resolveSafeMaterializationCwd(cwdInput);

  await assertNoSymlinkComponents(cwd, AGENT_MATERIALIZATION_ROOT_RELATIVE);
  await assertNoSymlinkComponents(
    cwd,
    `${AGENT_MATERIALIZATION_ROOT_RELATIVE}/${RUNS_DIR}`,
  );

  try {
    const entries = await readdir(path.join(rootPath(cwd), RUNS_DIR), {
      withFileTypes: true,
    });

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => assertRunId(entry.name.slice(0, -".json".length)))
      .sort();
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}
