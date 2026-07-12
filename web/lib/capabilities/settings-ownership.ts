import "server-only";

import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import {
  assertSafeAgentMaterializationPath,
  materializeWithAgentLease,
  withAgentMaterializationLock,
} from "@/lib/agents/materialization-manifest";
import { atomicWriteText } from "@/lib/atomic";
import { MaisterError } from "@/lib/errors";

export const SETTINGS_RELATIVE = ".claude/settings.local.json";
export const SETTINGS_MARKER_RELATIVE = `${SETTINGS_RELATIVE}.maister-owned`;
export const SETTINGS_BACKUP_RELATIVE = `${SETTINGS_RELATIVE}.maister-bak`;
export const SETTINGS_OPERATION_RELATIVE = `${SETTINGS_RELATIVE}.maister-operation`;

const log = pino({
  name: "capability-settings-ownership",
  level: process.env.LOG_LEVEL ?? "info",
});

export type SettingsOwner =
  | { readonly kind: "capability"; readonly runId: string }
  | { readonly kind: "agent-l2"; readonly runId: string }
  | { readonly kind: "unknown" };

export type CapabilitySettingsReclaimResult =
  | { readonly status: "absent" }
  | { readonly status: "reclaimed" }
  | { readonly status: "foreign"; readonly owner: SettingsOwner }
  | { readonly status: "failed"; readonly error: string };

export type CapabilitySettingsOperationPhase =
  | "prepared"
  | "backup_captured"
  | "settings_written"
  | "active"
  | "restore_started"
  | "settings_restored";

type CapabilitySettingsOperation = {
  readonly version: 2;
  readonly kind: "capability";
  readonly runId: string;
  readonly hadSettings: boolean;
  readonly phase: CapabilitySettingsOperationPhase;
};

type ParsedCapabilitySettingsOperation =
  | CapabilitySettingsOperation
  | {
      readonly version: 1;
      readonly kind: "capability";
      readonly runId: string;
      readonly hadSettings: boolean;
      readonly phase: "legacy";
    };

const CAPABILITY_SETTINGS_OPERATION_PHASES =
  new Set<CapabilitySettingsOperationPhase>([
    "prepared",
    "backup_captured",
    "settings_written",
    "active",
    "restore_started",
    "settings_restored",
  ]);

function isCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { readonly code?: unknown }).code === code
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownerMarker(kind: "capability" | "agent-l2", runId: string): string {
  return `${kind}:${runId}\n`;
}

export function agentL2SettingsMarker(runId: string): string {
  return ownerMarker("agent-l2", runId);
}

export function capabilitySettingsMarker(runId: string): string {
  return ownerMarker("capability", runId);
}

export function capabilitySettingsOperation(
  runId: string,
  hadSettings: boolean,
  phase: CapabilitySettingsOperationPhase = "prepared",
): string {
  return `${JSON.stringify({
    version: 2,
    kind: "capability",
    runId,
    hadSettings,
    phase,
  } satisfies CapabilitySettingsOperation)}\n`;
}

function parseOwner(value: string): SettingsOwner {
  const marker = value.trim();
  const match = /^(capability|agent-l2):([A-Za-z0-9._-]+)$/.exec(marker);

  if (!match) return { kind: "unknown" };

  return {
    kind: match[1] as "capability" | "agent-l2",
    runId: match[2],
  };
}

function parseCapabilitySettingsOperation(
  value: string,
): ParsedCapabilitySettingsOperation {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `capability settings operation is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (
    !isRecord(parsed) ||
    parsed.kind !== "capability" ||
    typeof parsed.runId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(parsed.runId) ||
    parsed.runId.includes("..") ||
    typeof parsed.hadSettings !== "boolean"
  ) {
    throw new MaisterError("CONFIG", "capability settings operation is corrupt");
  }

  if (parsed.version === 1) {
    return {
      version: 1,
      kind: "capability",
      runId: parsed.runId,
      hadSettings: parsed.hadSettings,
      phase: "legacy",
    };
  }

  if (
    parsed.version !== 2 ||
    typeof parsed.phase !== "string" ||
    !CAPABILITY_SETTINGS_OPERATION_PHASES.has(
      parsed.phase as CapabilitySettingsOperationPhase,
    )
  ) {
    throw new MaisterError("CONFIG", "capability settings operation is corrupt");
  }

  return {
    version: 2,
    kind: "capability",
    runId: parsed.runId,
    hadSettings: parsed.hadSettings,
    phase: parsed.phase as CapabilitySettingsOperationPhase,
  };
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await lstat(pathValue);

    return true;
  } catch (err) {
    if (isCode(err, "ENOENT")) return false;
    throw err;
  }
}

async function readSettingsOwnerAtCwd(
  cwd: string,
): Promise<SettingsOwner | null> {
  await assertSafeAgentMaterializationPath(cwd, SETTINGS_MARKER_RELATIVE);

  try {
    return parseOwner(
      await readFile(path.join(cwd, SETTINGS_MARKER_RELATIVE), "utf8"),
    );
  } catch (err) {
    if (isCode(err, "ENOENT")) return null;
    throw err;
  }
}

async function readCapabilitySettingsOperationAtCwd(
  cwd: string,
): Promise<ParsedCapabilitySettingsOperation | null> {
  await assertSafeAgentMaterializationPath(cwd, SETTINGS_OPERATION_RELATIVE);

  try {
    return parseCapabilitySettingsOperation(
      await readFile(path.join(cwd, SETTINGS_OPERATION_RELATIVE), "utf8"),
    );
  } catch (err) {
    if (isCode(err, "ENOENT")) return null;
    throw err;
  }
}

async function assertCapabilitySettingsPaths(cwd: string): Promise<void> {
  await assertSafeAgentMaterializationPath(cwd, SETTINGS_RELATIVE);
  await assertSafeAgentMaterializationPath(cwd, SETTINGS_MARKER_RELATIVE);
  await assertSafeAgentMaterializationPath(cwd, SETTINGS_BACKUP_RELATIVE);
  await assertSafeAgentMaterializationPath(cwd, SETTINGS_OPERATION_RELATIVE);
}

async function writeCapabilitySettingsOperationAtCwd(args: {
  readonly cwd: string;
  readonly runId: string;
  readonly hadSettings: boolean;
  readonly phase: CapabilitySettingsOperationPhase;
}): Promise<CapabilitySettingsOperation> {
  await atomicWriteText(
    path.join(args.cwd, SETTINGS_OPERATION_RELATIVE),
    capabilitySettingsOperation(args.runId, args.hadSettings, args.phase),
  );

  return {
    version: 2,
    kind: "capability",
    runId: args.runId,
    hadSettings: args.hadSettings,
    phase: args.phase,
  };
}

async function clearCapabilitySettingsLifecycleAtCwd(cwd: string): Promise<void> {
  await rm(path.join(cwd, SETTINGS_BACKUP_RELATIVE), { force: true });
  await rm(path.join(cwd, SETTINGS_MARKER_RELATIVE), { force: true });
  await rm(path.join(cwd, SETTINGS_OPERATION_RELATIVE), { force: true });
}

function missingCapabilitySettingsBackupError(
  operation: ParsedCapabilitySettingsOperation,
): MaisterError {
  return new MaisterError(
    "CONFIG",
    `capability settings ${operation.phase} operation recorded an original file but its backup is missing`,
  );
}

function unexpectedCapabilitySettingsBackupError(): MaisterError {
  return new MaisterError(
    "CONFIG",
    "capability settings operation recorded no original file but its backup exists",
  );
}

async function recoverInterruptedCapabilitySettingsAtCwd(
  cwd: string,
  operation: ParsedCapabilitySettingsOperation,
): Promise<void> {
  const settingsPath = path.join(cwd, SETTINGS_RELATIVE);
  const backupPath = path.join(cwd, SETTINGS_BACKUP_RELATIVE);

  await assertCapabilitySettingsPaths(cwd);

  const backupExists = await pathExists(backupPath);

  if (operation.phase === "active") {
    throw new MaisterError(
      "CONFIG",
      "capability settings active operation is missing its ownership marker",
    );
  }

  if (operation.phase === "settings_restored") {
    await clearCapabilitySettingsLifecycleAtCwd(cwd);
  } else if (operation.hadSettings) {
    if (!backupExists) {
      // v2 records this phase before the first backup write. The unchanged
      // settings file is therefore still the user's original; every later
      // phase is ambiguous without a backup and must remain retryable.
      if (operation.phase !== "prepared") {
        throw missingCapabilitySettingsBackupError(operation);
      }
      if (!(await pathExists(settingsPath))) {
        throw new MaisterError(
          "CONFIG",
          "capability settings pre-backup operation is missing its original file",
        );
      }

      await rm(path.join(cwd, SETTINGS_MARKER_RELATIVE), { force: true });
      await rm(path.join(cwd, SETTINGS_OPERATION_RELATIVE), { force: true });
    } else {
      await atomicWriteText(settingsPath, await readFile(backupPath, "utf8"));
      await writeCapabilitySettingsOperationAtCwd({
        cwd,
        runId: operation.runId,
        hadSettings: true,
        phase: "settings_restored",
      });
      await clearCapabilitySettingsLifecycleAtCwd(cwd);
    }
  } else {
    if (backupExists) throw unexpectedCapabilitySettingsBackupError();

    await rm(settingsPath, { force: true });
    await writeCapabilitySettingsOperationAtCwd({
      cwd,
      runId: operation.runId,
      hadSettings: false,
      phase: "settings_restored",
    });
    await clearCapabilitySettingsLifecycleAtCwd(cwd);
  }

  log.warn(
    {
      cwd,
      runId: operation.runId,
      hadSettings: operation.hadSettings,
      phase: operation.phase,
    },
    "recovered interrupted capability settings materialization",
  );
}

async function reclaimOwnedCapabilitySettingsAtCwd(args: {
  readonly cwd: string;
  readonly runId: string;
  readonly operation: ParsedCapabilitySettingsOperation | null;
}): Promise<void> {
  const settingsPath = path.join(args.cwd, SETTINGS_RELATIVE);
  const backupPath = path.join(args.cwd, SETTINGS_BACKUP_RELATIVE);

  await assertCapabilitySettingsPaths(args.cwd);

  const backupExists = await pathExists(backupPath);

  if (args.operation?.phase === "settings_restored") {
    await clearCapabilitySettingsLifecycleAtCwd(args.cwd);

    return;
  }

  let operation: CapabilitySettingsOperation;

  if (args.operation === null) {
    // Legacy active records had no journal after materialization. A remaining
    // backup proves the original can be restored; without one, deletion would
    // be ambiguous after a crash between restore and marker removal.
    if (!backupExists) {
      throw new MaisterError(
        "CONFIG",
        "capability settings ownership marker has no lifecycle journal or backup",
      );
    }
    operation = await writeCapabilitySettingsOperationAtCwd({
      cwd: args.cwd,
      runId: args.runId,
      hadSettings: true,
      phase: "restore_started",
    });
  } else {
    if (args.operation.hadSettings && !backupExists) {
      throw missingCapabilitySettingsBackupError(args.operation);
    }
    if (!args.operation.hadSettings && backupExists) {
      throw unexpectedCapabilitySettingsBackupError();
    }
    operation = await writeCapabilitySettingsOperationAtCwd({
      cwd: args.cwd,
      runId: args.operation.runId,
      hadSettings: args.operation.hadSettings,
      phase: "restore_started",
    });
  }

  if (operation.hadSettings) {
    await atomicWriteText(settingsPath, await readFile(backupPath, "utf8"));
  } else {
    await rm(settingsPath, { force: true });
  }

  await writeCapabilitySettingsOperationAtCwd({
    cwd: args.cwd,
    runId: operation.runId,
    hadSettings: operation.hadSettings,
    phase: "settings_restored",
  });
  await clearCapabilitySettingsLifecycleAtCwd(args.cwd);
}

export async function readSettingsOwner(
  cwdInput: string,
): Promise<SettingsOwner | null> {
  const cwd = await assertSafeAgentMaterializationPath(cwdInput, ".claude");

  return readSettingsOwnerAtCwd(cwd);
}

/**
 * Claims the shared Claude settings file for one capability-profile run. A
 * durable operation record precedes every backup/write/marker mutation, so a
 * crash can restore the user's original settings before its lease is released.
 */
export async function materializeCapabilitySettings(args: {
  readonly cwd: string;
  readonly runId: string;
  readonly content: string;
}): Promise<string> {
  const cwd = await assertSafeAgentMaterializationPath(args.cwd, ".claude");
  const settingsPath = path.join(cwd, SETTINGS_RELATIVE);
  const markerPath = path.join(cwd, SETTINGS_MARKER_RELATIVE);
  const backupPath = path.join(cwd, SETTINGS_BACKUP_RELATIVE);
  const operationPath = path.join(cwd, SETTINGS_OPERATION_RELATIVE);

  await materializeWithAgentLease({
    cwd,
    runId: args.runId,
    materialize: async (ownedPaths, recordIntent, ownedByRunPaths) => {
      let owner = await readSettingsOwnerAtCwd(cwd);
      const interrupted = await readCapabilitySettingsOperationAtCwd(cwd);

      if (interrupted?.phase === "active" && owner === null) {
        throw new MaisterError(
          "CONFIG",
          "capability settings active operation is missing its ownership marker",
        );
      }

      if (interrupted !== null && interrupted.phase !== "active") {
        if (interrupted.runId !== args.runId) {
          throw new MaisterError(
            "CONFLICT",
            `settings.local.json has an interrupted capability operation for run ${interrupted.runId}`,
          );
        }
        if (
          owner !== null &&
          (owner.kind !== "capability" || owner.runId !== args.runId)
        ) {
          throw new MaisterError(
            "CONFIG",
            "capability settings marker conflicts with its interrupted operation",
          );
        }

        if (owner?.kind === "capability") {
          await reclaimOwnedCapabilitySettingsAtCwd({
            cwd,
            runId: args.runId,
            operation: interrupted,
          });
        } else {
          await recoverInterruptedCapabilitySettingsAtCwd(cwd, interrupted);
        }
        owner = await readSettingsOwnerAtCwd(cwd);
      }

      if (
        owner !== null &&
        (owner.kind !== "capability" || owner.runId !== args.runId)
      ) {
        throw new MaisterError(
          "CONFLICT",
          `settings.local.json is owned by ${owner.kind === "unknown" ? "an unknown MAIster writer" : `${owner.kind} run ${owner.runId}`}`,
        );
      }

      const trackedByAnotherRun = [
        SETTINGS_RELATIVE,
        SETTINGS_MARKER_RELATIVE,
        SETTINGS_BACKUP_RELATIVE,
        SETTINGS_OPERATION_RELATIVE,
      ].some(
        (relativePath) =>
          ownedPaths.has(relativePath) && !ownedByRunPaths.has(relativePath),
      );

      if (owner === null && trackedByAnotherRun) {
        throw new MaisterError(
          "CONFIG",
          "settings.local.json lease exists without a matching ownership marker",
        );
      }

      await assertSafeAgentMaterializationPath(cwd, ".claude");
      await mkdir(path.join(cwd, ".claude"), { recursive: true });
      await assertSafeAgentMaterializationPath(cwd, ".claude");
      await assertCapabilitySettingsPaths(cwd);
      await recordIntent([
        settingsPath,
        markerPath,
        backupPath,
        operationPath,
      ]);

      if (owner === null) {
        const hadSettings = await pathExists(settingsPath);

        if (hadSettings && (await pathExists(backupPath))) {
          throw new MaisterError(
            "CONFIG",
            "settings.local.json backup exists without an ownership marker",
          );
        }

        await writeCapabilitySettingsOperationAtCwd({
          cwd,
          runId: args.runId,
          hadSettings,
          phase: "prepared",
        });
        if (hadSettings) {
          await atomicWriteText(backupPath, await readFile(settingsPath, "utf8"));
          await writeCapabilitySettingsOperationAtCwd({
            cwd,
            runId: args.runId,
            hadSettings: true,
            phase: "backup_captured",
          });
        }
        await atomicWriteText(settingsPath, args.content);
        await writeCapabilitySettingsOperationAtCwd({
          cwd,
          runId: args.runId,
          hadSettings,
          phase: "settings_written",
        });
        await atomicWriteText(markerPath, capabilitySettingsMarker(args.runId));
        await writeCapabilitySettingsOperationAtCwd({
          cwd,
          runId: args.runId,
          hadSettings,
          phase: "active",
        });
      } else {
        await atomicWriteText(settingsPath, args.content);
      }

      return [settingsPath, markerPath, backupPath, operationPath];
    },
  });

  return settingsPath;
}

/**
 * Restores a capability-owned settings file only when this exact run still owns
 * the marker. Foreign and malformed markers are retained so a terminal cleanup
 * can retry after the live owner exits instead of deleting another run's state.
 */
export async function reclaimCapabilitySettings(args: {
  readonly cwd: string;
  readonly runId: string;
}): Promise<CapabilitySettingsReclaimResult> {
  try {
    return await withAgentMaterializationLock(args.cwd, async (cwd) => {
      const owner = await readSettingsOwnerAtCwd(cwd);
      const operation = await readCapabilitySettingsOperationAtCwd(cwd);

      if (owner === null && operation === null) {
        await assertCapabilitySettingsPaths(cwd);
        if (await pathExists(path.join(cwd, SETTINGS_BACKUP_RELATIVE))) {
          throw new MaisterError(
            "CONFIG",
            "settings.local.json backup exists without ownership state",
          );
        }

        return { status: "absent" };
      }
      if (owner === null && operation?.runId === args.runId) {
        await recoverInterruptedCapabilitySettingsAtCwd(cwd, operation);

        return { status: "reclaimed" };
      }
      if (owner === null) {
        return { status: "foreign", owner: { kind: "unknown" } };
      }
      if (owner.kind !== "capability" || owner.runId !== args.runId) {
        return { status: "foreign", owner };
      }

      if (operation !== null && operation.runId !== args.runId) {
        return { status: "foreign", owner: { kind: "unknown" } };
      }
      await reclaimOwnedCapabilitySettingsAtCwd({
        cwd,
        runId: args.runId,
        operation,
      });

      return { status: "reclaimed" };
    });
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
