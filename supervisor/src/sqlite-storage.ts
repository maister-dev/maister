import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "pino";
import type { RuntimeLimits } from "./runtime-limits";

import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { HostRuntimeEventError } from "./host-runtime-errors";
import { SQLITE_WRITE_HEADROOM_BYTES } from "./runtime-limits";

export const SQLITE_CHECKPOINT_TARGET_BYTES = 64 * 1024 * 1024;
const AMORTIZE_MAX_OPS = 16;
const AMORTIZE_MAX_BYTES = 512 * 1024;
const AMORTIZE_MIN_MARGIN_BYTES = 8 * 1024 * 1024;
const AMORTIZE_ESTIMATED_OP_BYTES = 32 * 1024;

function canReuseSnapshot(input: {
  file: string | null;
  pressured: boolean;
  cached: PhysicalStorageSnapshot | null;
  cachedOps: number;
  cachedEstimatedBytes: number;
  deltaBytes: number;
  headroom: number;
  limits: RuntimeLimits;
}): boolean {
  const {
    file,
    pressured,
    cached,
    cachedOps,
    cachedEstimatedBytes,
    deltaBytes,
    headroom,
    limits,
  } = input;

  if (file === null || pressured || cached === null) return false;
  if (cachedOps >= AMORTIZE_MAX_OPS) return false;
  const projectedBytes = cachedEstimatedBytes + deltaBytes;

  if (projectedBytes > AMORTIZE_MAX_BYTES) return false;

  return (
    cached.walBytes + projectedBytes + AMORTIZE_MIN_MARGIN_BYTES <
      SQLITE_CHECKPOINT_TARGET_BYTES &&
    cached.totalBytes + projectedBytes + headroom + AMORTIZE_MIN_MARGIN_BYTES <
      limits.stateMaxBytes &&
    (cached.filesystemFreeBytes === null ||
      cached.filesystemFreeBytes >=
        limits.runtimeMinFreeBytes +
          headroom +
          projectedBytes +
          AMORTIZE_MIN_MARGIN_BYTES)
  );
}

export type SqliteStorageSnapshot = Readonly<{
  databaseBytes: number;
  walBytes: number;
  sharedMemoryBytes: number;
  totalBytes: number;
  pageBytes: number;
  pageCount: number;
  freePages: number;
  filesystemFreeBytes: number | null;
}>;

type PhysicalStorageSnapshot = Pick<
  SqliteStorageSnapshot,
  | "databaseBytes"
  | "walBytes"
  | "sharedMemoryBytes"
  | "totalBytes"
  | "filesystemFreeBytes"
>;

export type SqliteStorage = {
  snapshot: () => SqliteStorageSnapshot;
  available: () => boolean;
  canAdmit: (reservedBytes: number) => boolean;
  admit: <T>(
    reservedBytes: number,
    operation: (snapshot: PhysicalStorageSnapshot) => T,
  ) => T | null;
  write: <T>(operation: () => T) => T;
  writeTemporary: <T>(operation: () => T) => T;
  reportFailure: (error: unknown) => void;
  subscribeFailure: (listener: () => void) => () => void;
};

function fileBytes(file: string): number {
  try {
    return statSync(file).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function databaseFileBytes(file: string): number {
  try {
    return statSync(file).size;
  } catch (error) {
    throw new HostRuntimeEventError(
      "runtime_storage_unavailable",
      "runtime state file cannot be measured; repair storage",
      { cause: error },
    );
  }
}

function pragmaNumber(
  db: DatabaseSync,
  name: "page_size" | "page_count" | "freelist_count",
): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;

  return Number(row[name]);
}

type StorageFailureSignature = Readonly<{
  reason: "runtime_storage_unavailable";
  code?: string;
  sqliteCode?: number;
}>;

/** Follow only a bounded error cause chain; never log arbitrary error bodies. */
function storageFailureSignature(
  error: unknown,
): StorageFailureSignature | null {
  let current = error;

  for (
    let depth = 0;
    depth < 8 && current !== null && typeof current === "object";
    depth += 1
  ) {
    if (
      current instanceof HostRuntimeEventError &&
      current.reason === "runtime_storage_unavailable"
    )
      return { reason: current.reason };
    const failure = current as {
      code?: unknown;
      errcode?: unknown;
      cause?: unknown;
    };

    if (
      typeof failure.code === "string" &&
      [
        "ENOSPC",
        "EDQUOT",
        "EIO",
        "EROFS",
        "EMFILE",
        "ENFILE",
        "EACCES",
        "ENOTDIR",
      ].includes(failure.code)
    )
      return { reason: "runtime_storage_unavailable", code: failure.code };
    // SQLite extended result codes retain their primary result in the low byte.
    if (
      failure.code === "ERR_SQLITE_ERROR" &&
      typeof failure.errcode === "number" &&
      [8, 10, 13, 14].includes(failure.errcode & 0xff)
    )
      return {
        reason: "runtime_storage_unavailable",
        code: failure.code,
        sqliteCode: failure.errcode,
      };
    current = failure.cause;
  }

  return null;
}

/** Synchronous writes cannot overlap; no checkpoint is attempted inside a transaction. */
export function createSqliteStorage(input: {
  db: DatabaseSync;
  file: string | null;
  limits: RuntimeLimits;
  logger?: Logger;
}): SqliteStorage {
  const { db, file, limits, logger } = input;
  let available = true;
  let pressured = false;
  let cachedPhysical: PhysicalStorageSnapshot | null = null;
  let cachedOps = 0;
  let cachedEstimatedBytes = 0;
  const invalidatePhysicalCache = (): void => {
    cachedPhysical = null;
    cachedOps = 0;
    cachedEstimatedBytes = 0;
  };
  const failureListeners = new Set<() => void>();
  const pageBytes = pragmaNumber(db, "page_size");

  if (file) {
    db.exec(
      `PRAGMA wal_autocheckpoint = ${Math.floor(SQLITE_CHECKPOINT_TARGET_BYTES / pageBytes)}`,
    );
    db.exec(`PRAGMA journal_size_limit = ${SQLITE_CHECKPOINT_TARGET_BYTES}`);
  }
  const physicalSnapshot = (): PhysicalStorageSnapshot => {
    const databaseBytes = file
      ? databaseFileBytes(file)
      : pragmaNumber(db, "page_count") * pageBytes;
    const walBytes = file ? fileBytes(`${file}-wal`) : 0;
    const sharedMemoryBytes = file ? fileBytes(`${file}-shm`) : 0;
    const fs = file ? statfsSync(dirname(file), { bigint: true }) : null;
    const freeBytes = fs ? fs.bavail * fs.bsize : null;

    return {
      databaseBytes,
      walBytes,
      sharedMemoryBytes,
      totalBytes: databaseBytes + walBytes + sharedMemoryBytes,
      filesystemFreeBytes:
        freeBytes === null
          ? null
          : Number(
              freeBytes > BigInt(Number.MAX_SAFE_INTEGER)
                ? BigInt(Number.MAX_SAFE_INTEGER)
                : freeBytes,
            ),
    };
  };
  const snapshot = (): SqliteStorageSnapshot => {
    invalidatePhysicalCache();

    return {
      ...physicalSnapshot(),
      pageBytes,
      pageCount: pragmaNumber(db, "page_count"),
      freePages: pragmaNumber(db, "freelist_count"),
    };
  };
  const markFailed = (error: unknown): void => {
    const failure = storageFailureSignature(error);

    if (!available || !failure) return;
    available = false;
    invalidatePhysicalCache();
    logger?.error(failure, "runtime-storage-unavailable");
    for (const listener of failureListeners) listener();
  };
  const measure = (
    headroom: number,
    deltaBytes = AMORTIZE_ESTIMATED_OP_BYTES,
  ): PhysicalStorageSnapshot => {
    if (
      canReuseSnapshot({
        file,
        pressured,
        cached: cachedPhysical,
        cachedOps,
        cachedEstimatedBytes,
        deltaBytes,
        headroom,
        limits,
      })
    ) {
      cachedOps += 1;
      cachedEstimatedBytes += deltaBytes;

      return cachedPhysical!;
    }
    let measured = physicalSnapshot();

    if (
      file &&
      !db.isTransaction &&
      (measured.walBytes >= SQLITE_CHECKPOINT_TARGET_BYTES ||
        measured.totalBytes + headroom >= limits.stateMaxBytes)
    ) {
      const result = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as {
        busy: number;
        log: number;
        checkpointed: number;
      };

      if (result.busy === 0 && result.log === result.checkpointed)
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      measured = physicalSnapshot();
      logger?.debug(
        {
          ...measured,
          checkpointBusy: result.busy,
          checkpointFrames: result.checkpointed,
          walFrames: result.log,
        },
        "runtime-state-checkpoint",
      );
    }

    if (file !== null && !pressured) {
      cachedPhysical = measured;
      cachedOps = 1;
      cachedEstimatedBytes = deltaBytes;
    } else {
      invalidatePhysicalCache();
    }

    return measured;
  };
  const fits = (measured: PhysicalStorageSnapshot, headroom: number): boolean =>
    measured.totalBytes + headroom < limits.stateMaxBytes &&
    (measured.filesystemFreeBytes === null ||
      measured.filesystemFreeBytes >= limits.runtimeMinFreeBytes + headroom);

  const writeTemporary = <T>(operation: () => T): T => {
    if (!available)
      throw new HostRuntimeEventError(
        "runtime_storage_unavailable",
        "runtime storage requires repair before writes can resume",
      );
    try {
      return operation();
    } catch (error) {
      markFailed(error);
      throw error;
    }
  };

  const admissionSnapshot = (
    reservedBytes: number,
  ): PhysicalStorageSnapshot | null => {
    if (!available) return null;
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0)
      throw new HostRuntimeEventError(
        "stream_corrupt",
        "invalid physical runtime storage reservation",
      );
    try {
      const headroom =
        SQLITE_WRITE_HEADROOM_BYTES +
        reservedBytes +
        (pressured ? SQLITE_WRITE_HEADROOM_BYTES : 0);
      const measured = measure(headroom);
      const nextPressure =
        !fits(measured, headroom) ||
        measured.walBytes + (pressured ? SQLITE_WRITE_HEADROOM_BYTES : 0) >=
          SQLITE_CHECKPOINT_TARGET_BYTES;

      if (pressured !== nextPressure)
        logger?.info(
          { ...measured, reservedBytes, pressured: nextPressure },
          "runtime-state-pressure-changed",
        );
      pressured = nextPressure;
      if (pressured) invalidatePhysicalCache();

      return pressured ? null : measured;
    } catch (error) {
      markFailed(error);
      throw error;
    }
  };

  return {
    snapshot,
    writeTemporary,
    available: () => available,
    reportFailure: markFailed,
    subscribeFailure(listener) {
      failureListeners.add(listener);

      return () => failureListeners.delete(listener);
    },
    canAdmit: (reservedBytes) => admissionSnapshot(reservedBytes) !== null,
    admit(reservedBytes, operation) {
      const measured = admissionSnapshot(reservedBytes);

      if (!measured) return null;

      // Admission already includes the bounded-write headroom; the callback
      // executes synchronously before any other reservation can spend it.
      return writeTemporary(() => operation(measured));
    },
    write<T>(operation: () => T): T {
      return writeTemporary(() => {
        if (
          !fits(
            measure(SQLITE_WRITE_HEADROOM_BYTES),
            SQLITE_WRITE_HEADROOM_BYTES,
          )
        ) {
          throw new HostRuntimeEventError(
            "runtime_storage_unavailable",
            "physical runtime state capacity cannot fund the next bounded write; repair storage",
          );
        }

        return operation();
      });
    },
  };
}
