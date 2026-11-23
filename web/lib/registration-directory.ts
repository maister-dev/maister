import "server-only";

import { lstat, mkdir, rm } from "node:fs/promises";

import pino from "pino";

import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "registration-directory",
  level: process.env.LOG_LEVEL ?? "info",
});

export type OwnedDirectory = { path: string; device: bigint; inode: bigint };

/** Exclusive creation proves that this request owns the directory it may undo. */
export async function createRegistrationDirectory(
  path: string,
): Promise<OwnedDirectory> {
  try {
    await mkdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST")
      throw new MaisterError("PRECONDITION", `target already exists: ${path}`);
    throw err;
  }
  const stats = await lstat(path, { bigint: true });

  return { path, device: stats.dev, inode: stats.ino };
}

export async function cleanRegistrationDirectory(
  directory: OwnedDirectory,
): Promise<void> {
  try {
    const stats = await lstat(directory.path, { bigint: true });

    if (
      stats.dev === directory.device &&
      stats.ino === directory.inode &&
      stats.isDirectory()
    )
      await rm(directory.path, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      log.error(
        { code: (err as NodeJS.ErrnoException).code },
        "registration directory cleanup failed",
      );
  }
}
