import "server-only";

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import { atomicWriteJson, atomicWriteText } from "@/lib/atomic";
import { MaisterError } from "@/lib/errors";

export const AGENT_MATERIALIZATION_ROOT_RELATIVE =
  ".maister/agent-materialization";
export const PACKAGE_SKILLS_MANIFEST_RELATIVE =
  AGENT_MATERIALIZATION_ROOT_RELATIVE;

const INDEX_FILE = "index.json";
const RUNS_DIR = "runs";
const LOCK_DIR = "lock";
const LOCK_OWNER_FILE = "owner";
const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 5_000;
const ALLOWED_ROOTS = [
  ".claude/skills",
  ".claude/agents",
  ".gemini/skills",
  ".maister/capabilities",
] as const;
const ALLOWED_FILES = [
  ".claude/settings.local.json",
  ".claude/settings.local.json.maister-owned",
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
  return path.join(path.resolve(cwd), AGENT_MATERIALIZATION_ROOT_RELATIVE);
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

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    const metadata = await stat(path.join(lockPath, LOCK_OWNER_FILE));

    return Date.now() - metadata.mtimeMs >= LOCK_STALE_MS;
  } catch (err) {
    if (!isMissing(err)) throw err;

    try {
      const metadata = await stat(lockPath);

      return Date.now() - metadata.mtimeMs >= LOCK_STALE_MS;
    } catch (lockErr) {
      if (isMissing(lockErr)) return false;
      throw lockErr;
    }
  }
}

async function withLock<T>(cwd: string, effect: () => Promise<T>): Promise<T> {
  const lockPath = path.join(rootPath(cwd), LOCK_DIR);
  const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
  const owner = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;

  await mkdir(rootPath(cwd), { recursive: true });

  for (;;) {
    try {
      await mkdir(lockPath);
      await atomicWriteText(ownerPath, owner);
      break;
    } catch (err) {
      if (
        typeof err !== "object" ||
        err === null ||
        !("code" in err) ||
        (err as { readonly code?: unknown }).code !== "EEXIST"
      ) {
        throw err;
      }

      if (await lockIsStale(lockPath)) {
        log.warn(
          { cwd, lockPath },
          "taking over stale agent materialization lock",
        );
        await rm(lockPath, { recursive: true, force: true });
        continue;
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

  const heartbeat = setInterval(() => {
    const now = new Date();

    void utimes(ownerPath, now, now).catch((err: unknown) => {
      log.warn(
        {
          cwd,
          owner,
          error: err instanceof Error ? err.message : String(err),
        },
        "agent materialization lock heartbeat failed",
      );
    });
  }, 1_000);

  try {
    return await effect();
  } finally {
    clearInterval(heartbeat);
    const currentOwner = await readFile(ownerPath, "utf8").catch(() => "");

    if (currentOwner === owner) {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

export async function materializeWithAgentLease(args: {
  readonly cwd: string;
  readonly runId: string;
  readonly materialize: (
    ownedPaths: ReadonlySet<string>,
    recordIntent: (absolutePaths: readonly string[]) => Promise<void>,
  ) => Promise<readonly string[]>;
}): Promise<string[]> {
  const cwd = path.resolve(args.cwd);

  return withLock(cwd, async () => {
    const index = await readIndex(cwd);
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
      const rollbackPaths = existing.paths.filter(
        (relativePath) => (index.leases[relativePath]?.length ?? 0) === 0,
      );
      const foreignLeaseProtectedPathCount =
        existing.paths.length - committedPaths.length - rollbackPaths.length;

      for (const relativePath of rollbackPaths) {
        await assertSafeOwnedTarget(cwd, relativePath);
        await rm(path.join(cwd, relativePath), {
          recursive: true,
          force: true,
        });
      }

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
          rolledBackPathCount: rollbackPaths.length,
          foreignLeaseProtectedPathCount,
        },
        "recovered interrupted agent materialization intent",
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
    );
    const newRelativePaths = normalizeDistinctPaths(
      absolutePaths.map((absolutePath) => path.relative(cwd, absolutePath)),
    );
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
  const target = path.join(
    cwd,
    normalizeAgentMaterializationPath(relativePath),
  );

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
): Promise<{
  readonly restoredPathCount: number;
  readonly remainingLeaseCount: number;
}> {
  const cwd = path.resolve(cwdInput);
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

    for (const relativePath of record.paths) {
      const owners = leases[relativePath] ?? [];

      if (!owners.includes(runId)) {
        if (record.state === "active") {
          throw new MaisterError(
            "CONFIG",
            `agent materialization lease is missing for ${runId}:${relativePath}`,
          );
        }
        if (owners.length > 0) continue;
        if (
          record.state === "releasing" &&
          (await assertSafeOwnedTarget(cwd, relativePath))
        ) {
          throw new MaisterError(
            "CONFIG",
            `agent materialization releasing target still exists without a lease for ${runId}:${relativePath}`,
          );
        }

        if (record.state === "preparing") removable.push(relativePath);
        continue;
      }

      const remaining = owners.filter((owner) => owner !== runId);

      if (remaining.length === 0) {
        delete leases[relativePath];
        removable.push(relativePath);
      } else {
        leases[relativePath] = remaining;
      }
    }

    if (record.state === "active") {
      await atomicWriteJson(runRecordPath(cwd, runId), {
        ...record,
        state: "releasing",
      });
    }

    for (const relativePath of removable) {
      await assertSafeOwnedTarget(cwd, relativePath);
      await rm(path.join(cwd, relativePath), { recursive: true, force: true });
    }

    await atomicWriteJson(indexPath(cwd), { version: 1, leases });
    if (record.state === "preparing") {
      await atomicWriteJson(runRecordPath(cwd, runId), {
        ...record,
        state: "releasing",
      });
    }
    await rm(runRecordPath(cwd, runId), { force: true });

    log.info(
      {
        runId,
        cwd,
        ownershipState: "released",
        restoredPathCount: removable.length,
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
  const record = await readRunRecord(path.resolve(cwd), runId);

  return record ? [...record.paths] : [];
}
