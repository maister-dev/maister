import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import pino from "pino";

import { isMaisterError, MaisterError } from "@/lib/errors";
import { logRange, statusPorcelain, writeRescueRef } from "@/lib/worktree";

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
  failureReason?:
    | "workspace_git_identity_invalid"
    | "workspace_preservation_failed";
  archivedCommit?: string;
  archivedBranch?: string;
  archivedAt?: Date;
  preservationOutcome?: "not_needed" | "ref_created" | "snapshot_created";
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

// A path staged against HEAD and then changed again in the tree: its staged
// version exists only in the index, and the snapshot's `add -A` overwrites it.
async function stagedWorkTheSnapshotOverwrites(
  worktreePath: string,
): Promise<boolean> {
  const names = async (args: string[]): Promise<string[]> =>
    (await git(worktreePath, ["diff", "--name-only", "-z", ...args]))
      .split("\0")
      .filter(Boolean);
  const staged = new Set(await names(["--cached"]));

  if (staged.size === 0) return false;

  return (await names([])).some((path) => staged.has(path));
}

// ADR-181 D8: a snapshot that precedes a removal overwrites staged work, and
// the removal then takes the only index that had it. Keep that index first, as
// a rescue ref whose second parent is the index as it stood. Null when nothing
// staged would be lost. Every removal that snapshots calls this first: the
// preserve below (GC, archive, drop, scratch discard) and the reconciler's
// orphan rescue.
export async function rescueStagedWorkBeforeSnapshot(args: {
  worktreePath: string;
  runId: string;
}): Promise<{ ref: string; sha: string } | null> {
  if (!(await stagedWorkTheSnapshotOverwrites(args.worktreePath))) return null;

  const rescue = await writeRescueRef(args);

  log.info(
    {
      runId: args.runId,
      worktreePath: args.worktreePath,
      rescueRef: rescue.ref,
    },
    "the index was kept as a rescue ref before the snapshot",
  );

  return rescue;
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
      // Check both identities before staging: a refused snapshot must not
      // change the caller's index merely because server Git is unconfigured.
      try {
        await git(worktreePath, ["var", "GIT_AUTHOR_IDENT"]);
        await git(worktreePath, ["var", "GIT_COMMITTER_IDENT"]);
      } catch (cause) {
        throw new MaisterError(
          "CONFIG",
          "Git could not resolve the snapshot author or committer identity",
          {
            cause,
            details: { reason: "workspace_git_identity_invalid" },
          },
        );
      }
      await rescueStagedWorkBeforeSnapshot({ worktreePath, runId });
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
      const archivedCommit = (
        await git(worktreePath, ["rev-parse", "HEAD"])
      ).trim();

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
        archivedCommit,
        archivedBranch: archiveBranch,
        archivedAt: new Date(),
        preservationOutcome: dirty ? "snapshot_created" : "ref_created",
        snapshotted: dirty,
      };
    }

    // Clean tree with no divergence — nothing to preserve.
    log.debug({ runId }, "GC preserve: clean, nothing to archive");

    return { ok: true, preservationOutcome: "not_needed" };
  } catch (err) {
    log.warn(
      {
        runId,
        worktreePath,
        branch,
        baseRef,
        err,
      },
      "GC preserve failed — caller MUST skip removal",
    );

    return {
      ok: false,
      failureReason:
        isMaisterError(err) &&
        err.details?.reason === "workspace_git_identity_invalid"
          ? "workspace_git_identity_invalid"
          : "workspace_preservation_failed",
    };
  }
}
