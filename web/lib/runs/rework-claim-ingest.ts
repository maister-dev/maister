import "server-only";

import pino from "pino";

import { MaisterError } from "@/lib/errors";
import {
  fastForwardWorktreeToRef,
  fetchRemote,
  listRemotes,
  remoteTrackingRefExists,
} from "@/lib/worktree";

const log = pino({
  name: "rework-claim-ingest",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ReworkIngestResult = {
  fastForwarded: boolean;
  before: string | null;
  after: string | null;
  // Which remote was actually fetched, or null when the ingest was a no-op.
  remote: string | null;
};

export type ReworkIngestArgs = {
  runId: string;
  worktreePath: string;
  parentRepoPath: string;
  branch: string;
  // Body-controlled. Validated against the repo's ACTUAL remotes before use.
  remote?: string | null;
};

const DEFAULT_REMOTE = "origin";

/**
 * ADR-160 D4: fetch + fast-forward ONLY.
 *
 * `git fetch <remote>` with no refspec (matching ADR-141, so `<remote>/<branch>`
 * really is refreshed), then a fast-forward of the run worktree's branch.
 * Divergence refuses `PRECONDITION` carrying the failing command, both SHAs,
 * ahead/behind counts, and copyable git instructions, and mutates nothing.
 *
 * A missing remote or an absent upstream is a **no-op success**, not a failure —
 * the purely-local edit loop must still be able to return.
 *
 * Merge, rebase, and AI conflict resolution are deliberately out of scope; the
 * escape hatch is export → resolve elsewhere → push → return.
 */
export async function ingestForReworkReturn(
  args: ReworkIngestArgs,
): Promise<ReworkIngestResult> {
  const requested = args.remote ?? null;
  const remotes = await listRemotes({ projectRepoPath: args.parentRepoPath });

  log.debug(
    { runId: args.runId, requested, remotes },
    "[rework-ingest] resolving remote",
  );

  // Body-controlled value validated against a server-derived allow-list.
  if (requested !== null && !remotes.includes(requested)) {
    throw new MaisterError(
      "PRECONDITION",
      `unknown remote "${requested}" — this repository has: ${remotes.join(", ") || "(none)"}`,
    );
  }

  const remote =
    requested ?? (remotes.includes(DEFAULT_REMOTE) ? DEFAULT_REMOTE : null);

  if (remote === null) {
    log.info(
      { runId: args.runId },
      "[rework-ingest] no remote configured — local-only return, nothing to ingest",
    );

    return { fastForwarded: false, before: null, after: null, remote: null };
  }

  await fetchRemote({ projectRepoPath: args.parentRepoPath, name: remote });

  const trackingRef = `${remote}/${args.branch}`;

  if (!(await remoteTrackingRefExists(args.worktreePath, trackingRef))) {
    log.info(
      { runId: args.runId, remote, trackingRef },
      "[rework-ingest] branch has no upstream — nothing to ingest",
    );

    return { fastForwarded: false, before: null, after: null, remote };
  }

  const outcome = await fastForwardWorktreeToRef(
    args.worktreePath,
    trackingRef,
  );

  if (outcome.kind === "diverged") {
    throw new MaisterError(
      "PRECONDITION",
      `branch has diverged from ${trackingRef} — fast-forward only. Resolve it in the worktree and push, then return again.`,
      {
        details: {
          command: outcome.command,
          localSha: outcome.localSha,
          remoteSha: outcome.remoteSha,
          aheadBy: outcome.aheadBy,
          behindBy: outcome.behindBy,
          instructions: [
            `git -C ${args.worktreePath} fetch ${remote}`,
            `git -C ${args.worktreePath} rebase ${trackingRef}`,
            `git -C ${args.worktreePath} push --force-with-lease`,
          ],
        },
      },
    );
  }

  const result: ReworkIngestResult =
    outcome.kind === "fast_forwarded"
      ? {
          fastForwarded: true,
          before: outcome.before,
          after: outcome.after,
          remote,
        }
      : {
          fastForwarded: false,
          before: outcome.sha,
          after: outcome.sha,
          remote,
        };

  log.info({ runId: args.runId, branch: args.branch, ...result }, "[rework-ingest] done");

  return result;
}
