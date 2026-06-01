import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import pino from "pino";

import { logRange, statusPorcelain } from "@/lib/worktree";

const execFileAsync = promisify(execFile);

const log = pino({
  name: "gc-preserve",
  level: process.env.LOG_LEVEL ?? "info",
});

const GIT_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

export interface PreserveWorktreeArgs {
  worktreePath: string;
  parentRepoPath: string;
  branch: string;
  baseRef: string;
  runId: string;
  archivePush?: boolean;
}

export interface PreserveResult {
  ok: boolean;
  archivedBranch?: string;
  archivedAt?: Date;
  snapshotted?: boolean;
}

async function git(
  worktreePath: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", worktreePath, ...args], {
    signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    maxBuffer: EXEC_MAX_BUFFER,
  });

  return stdout;
}

// Codex F1: preserve EVERYTHING (tracked + untracked + committed divergence)
// BEFORE any removal, and NEVER throw. Any git failure in the preserve steps →
// {ok:false} so the caller skips removeOwnedWorktree. NEVER merges to
// main/target — it only snapshots the worktree HEAD and force-creates a
// detached archive ref off it.
export async function preserveWorktree(
  args: PreserveWorktreeArgs,
): Promise<PreserveResult> {
  const { worktreePath, branch, baseRef, runId } = args;
  const archiveBranch = `maister/archive/${runId}`;

  try {
    const porcelain = await statusPorcelain({ worktreePath });
    const dirty = porcelain.trim() !== "";

    if (dirty) {
      // Capture tracked + untracked into a snapshot commit on the worktree's
      // own HEAD (the run branch), so `git branch -f` HEAD carries everything.
      await git(worktreePath, ["add", "-A"]);
      await git(worktreePath, [
        "commit",
        "--no-verify",
        "-m",
        `maister: GC snapshot of ${runId}`,
      ]);
    }

    const diverged =
      (await logRange({ worktreePath, baseRef, branch })).trim() !== "";

    if (dirty || diverged) {
      await git(worktreePath, ["branch", "-f", archiveBranch, "HEAD"]);

      if (args.archivePush) {
        const remotes = (await git(worktreePath, ["remote"])).trim();

        if (remotes !== "") {
          try {
            await git(worktreePath, [
              "push",
              "origin",
              `${archiveBranch}:${archiveBranch}`,
            ]);
          } catch (err) {
            // The local archive ref already preserves the work; a failed push
            // is a WARN, not a preserve failure (caller may still safely prune).
            log.warn(
              {
                runId,
                archiveBranch,
                err: err instanceof Error ? err.message : String(err),
              },
              "GC preserve: archive push failed (local ref preserves the work)",
            );
          }
        }
      }

      log.info(
        { runId, archiveBranch, snapshotted: dirty },
        "GC preserve: archived worktree",
      );

      return {
        ok: true,
        archivedBranch: archiveBranch,
        archivedAt: new Date(),
        snapshotted: dirty,
      };
    }

    // Clean tree with no divergence — nothing to preserve.
    log.debug({ runId }, "GC preserve: clean, nothing to archive");

    return { ok: true };
  } catch (err) {
    log.warn(
      {
        runId,
        worktreePath,
        err: err instanceof Error ? err.message : String(err),
      },
      "GC preserve failed — caller MUST skip removal",
    );

    return { ok: false };
  }
}
