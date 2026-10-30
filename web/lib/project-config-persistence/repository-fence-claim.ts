import "server-only";

import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import pino from "pino";

import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "project-config-persistence/fence-claim",
  level: process.env.LOG_LEVEL ?? "info",
});

function claimBusy(): MaisterError {
  return new MaisterError(
    "CONFLICT",
    "Repository ownership is being recovered. Retry when the other operation finishes; preserve unknown lock files for operator inspection.",
    { details: { reason: "operation_busy" } },
  );
}

/**
 * A short kernel mutex protects fence-owner replacement. The empty SQLite file
 * is permanent: unlinking it would allow contenders to lock different inodes.
 * No configuration or operation state is stored here. Process death releases
 * the transaction, while the durable owner and Git groups still require proof.
 */
export async function acquireRepositoryFenceClaim(
  commonDirectory: string,
): Promise<() => Promise<void>> {
  const legacyClaim = join(
    commonDirectory,
    "maister-config-mutation.recovery.lock",
  );

  try {
    await lstat(legacyClaim);
    // Old anonymous claims cannot prove ownership; never erase operator evidence.
    throw claimBusy();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const path = join(commonDirectory, "maister-config-mutation.mutex.sqlite");

  try {
    const created = await open(path, "wx", 0o600);

    await created.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);

  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size !== 0)
    throw claimBusy();
  const connection = new DatabaseSync(path);

  try {
    connection.exec("PRAGMA busy_timeout = 0");
    connection.exec("BEGIN IMMEDIATE");
  } catch (error) {
    connection.close();
    const sqliteCode = (error as { errcode?: number }).errcode;

    if (sqliteCode === 5 || sqliteCode === 6) throw claimBusy();
    log.error(
      { sqliteCode, error },
      "[FIX:config-fence] repository ownership mutex failed",
    );
    throw error;
  }

  return async () => {
    try {
      connection.exec("ROLLBACK");
    } finally {
      connection.close();
    }
  };
}
