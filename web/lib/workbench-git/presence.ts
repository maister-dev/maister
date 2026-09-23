import "server-only";

import { stat } from "node:fs/promises";

import pino from "pino";

const log = pino({
  name: "workbench-git-presence",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-181 D14: "the worktree is usable" has ONE definition on every surface —
// the row is not removed AND the path is a directory. This is the path half: a
// stat, never git state (cards and rail rows must stay cheap). Bounded to one
// page of rows by the callers.
export async function worktreePresence(
  paths: readonly string[],
): Promise<Map<string, boolean>> {
  const unique = [...new Set(paths)];
  const entries = await Promise.all(
    unique.map(async (path): Promise<[string, boolean]> => {
      try {
        return [path, (await stat(path)).isDirectory()];
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;

        if (code !== "ENOENT" && code !== "ENOTDIR") {
          log.warn({ path, code }, "worktree presence stat failed");
        }

        return [path, false];
      }
    }),
  );

  return new Map(entries);
}
