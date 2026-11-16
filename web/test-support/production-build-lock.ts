import { randomUUID } from "node:crypto";
import {
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import pino from "pino";

import {
  invocationFromEnvironment,
  findProcessIdentity,
  processIdentity,
  sameProcess,
} from "./process-invocation";

const BUILD_LOCK_POLL_MS = 500;
const log = pino({
  name: "production-build-lock",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Serializes one explicit build artifact namespace using a complete process witness. */
export async function acquireProductionBuildLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  const invocation = invocationFromEnvironment();

  if (!invocation)
    throw new Error("production build requires a test invocation");
  const identity = await processIdentity(invocation, process.pid);
  const ownerFile = path.join(
    invocation.directory,
    `build-lock-${randomUUID()}.json`,
  );

  // Publish the complete identity before atomically installing its symlink.
  // A death between allocation and publication cannot create an ownerless lock.
  await writeFile(ownerFile, JSON.stringify(identity), {
    flag: "wx",
    mode: 0o600,
  });
  const deadline = Date.now() + 20 * 60 * 1000;

  while (Date.now() < deadline) {
    try {
      await symlink(ownerFile, lockPath);

      return async () => {
        if ((await readlink(lockPath)) !== ownerFile)
          throw new Error("build lock owner changed before release");
        await unlink(lockPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let target: string | undefined;

      try {
        target = await readlink(lockPath);
        const owner = JSON.parse(
          await readFile(lockPath, "utf8"),
        ) as typeof identity;
        const current = await findProcessIdentity(invocation, owner.pid);

        if (!current || !sameProcess(owner, current)) {
          if ((await readlink(lockPath)) === target) {
            await unlink(lockPath);
            log.info(
              {
                lockPath,
                ownerPid: owner.pid,
                currentPid: current?.pid ?? null,
              },
              "[FIX:production-build-lock] reclaimed a proved dead build owner",
            );
          }
        } else {
          await new Promise((resolve) =>
            setTimeout(resolve, BUILD_LOCK_POLL_MS),
          );
        }
      } catch (inspectionError) {
        const code = (inspectionError as NodeJS.ErrnoException).code;

        // The retired lock was an EMPTY directory at this same path, reclaimed
        // by elapsed age. A checkout that ran it and crashed leaves one behind,
        // and `readlink` answers EINVAL on a directory — not ENOENT — so
        // without this arm every acquisition rethrows a bare EINVAL until
        // someone deletes the path by hand. An empty directory carries no owner
        // identity to prove alive, which is why the format was retired; a
        // non-empty one is not ours to remove.
        if (code === "EINVAL") {
          if ((await readdir(lockPath)).length)
            throw new Error(
              `unrecognized build lock at ${lockPath}; remove it to proceed`,
            );
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
        if (code !== "ENOENT") throw inspectionError;
        if (target !== undefined) {
          const currentTarget = await readlink(lockPath).catch(
            (readError: NodeJS.ErrnoException) => {
              if (readError.code !== "ENOENT") throw readError;

              return null;
            },
          );

          if (currentTarget === target)
            throw new Error(
              `production build lock owner identity is missing at ${target}; preserve the lock and reconcile its owner explicitly`,
              { cause: inspectionError },
            );
        }
        // Another contender released the same lock. Retry acquisition.
      }
    }
  }
  throw new Error(
    "production build lock did not become available within 20 minutes",
  );
}
