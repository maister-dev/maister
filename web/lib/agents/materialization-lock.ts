import "server-only";

import { lstat } from "node:fs/promises";
import path from "node:path";

import { DatabaseSync } from "node:sqlite";

import { MaisterError } from "@/lib/errors";

const MUTEX_FILE = "mutex.sqlite";
const SQLITE_AUXILIARY_FILES = [
  MUTEX_FILE,
  `${MUTEX_FILE}-journal`,
  `${MUTEX_FILE}-shm`,
  `${MUTEX_FILE}-wal`,
] as const;

export type MaterializationLockHandle = {
  readonly connection: DatabaseSync;
  released: boolean;
};

function isCode(err: unknown, ...codes: readonly string[]): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    codes.includes(String((err as { readonly code?: unknown }).code))
  );
}

async function assertSafeDirectory(pathValue: string): Promise<void> {
  try {
    const metadata = await lstat(pathValue);

    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new MaisterError(
        "CONFIG",
        `agent materialization lock directory is unsafe: ${pathValue}`,
      );
    }
  } catch (err) {
    if (isCode(err, "ENOENT")) return;
    throw err;
  }
}

async function assertSafeMutexFiles(rootPath: string): Promise<void> {
  await assertSafeDirectory(rootPath);

  for (const fileName of SQLITE_AUXILIARY_FILES) {
    const filePath = path.join(rootPath, fileName);

    try {
      if ((await lstat(filePath)).isSymbolicLink()) {
        throw new MaisterError(
          "CONFIG",
          `agent materialization mutex is symlinked: ${filePath}`,
        );
      }
    } catch (err) {
      if (isCode(err, "ENOENT")) continue;
      throw err;
    }
  }
}

function isSqliteBusy(err: unknown): boolean {
  return (
    isCode(err, "ERR_SQLITE_ERROR") &&
    err instanceof Error &&
    /database is locked/i.test(err.message)
  );
}

function closeAfterAcquireFailure(connection: DatabaseSync): void {
  try {
    connection.close();
  } catch {
    // The original acquisition failure is the actionable error.
  }
}

/**
 * Acquires an OS-backed exclusive transaction. SQLite releases that lock when
 * the process exits, so a crashed owner cannot leave a stale pathname that a
 * later caller must compare-and-unlink.
 */
export async function tryAcquireMaterializationLock(
  rootPath: string,
): Promise<MaterializationLockHandle | null> {
  await assertSafeMutexFiles(rootPath);

  const mutexPath = path.join(rootPath, MUTEX_FILE);
  let connection: DatabaseSync | null = null;

  try {
    connection = new DatabaseSync(mutexPath);
    connection.exec("PRAGMA busy_timeout = 0");
    connection.exec("BEGIN IMMEDIATE");
  } catch (err) {
    if (connection) closeAfterAcquireFailure(connection);
    if (isSqliteBusy(err)) return null;
    throw new MaisterError(
      "CONFIG",
      `cannot acquire agent materialization mutex in ${rootPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await assertSafeMutexFiles(rootPath);
  } catch (err) {
    closeAfterAcquireFailure(connection);
    throw err;
  }

  return { connection, released: false };
}

export async function releaseMaterializationLock(
  handle: MaterializationLockHandle,
): Promise<void> {
  if (handle.released) return;

  handle.released = true;

  try {
    // The mutex transaction holds no application data. Rolling it back makes
    // that intent explicit while still releasing SQLite's OS-backed lock.
    handle.connection.exec("ROLLBACK");
  } catch {
    // A crashed owner may have already lost the transaction; closing still
    // releases SQLite's OS-backed lock.
  } finally {
    handle.connection.close();
  }
}
