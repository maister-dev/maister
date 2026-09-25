import "server-only";

import pino from "pino";

import { isMaisterError, MaisterError } from "@/lib/errors";
import { fetchRemote, remoteOnlyCommitCount } from "@/lib/worktree";

const log = pino({
  name: "publication-guard",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-181 (C, owner 2026-09-25): a force-push would drop commits only the
// publication has — a reviewer's fixup, a suggestion committed on the PR. The
// refusal names what a force would replace so a human can confirm exactly that
// head, or bring the commits in first (update onto the publication).
export class PublicationDivergedError extends MaisterError {
  readonly remoteHead: string | null;
  readonly remoteRef: string;
  readonly remoteOnlyCommits: number | null;

  constructor(args: {
    remoteHead: string | null;
    remoteRef: string;
    remoteOnlyCommits: number | null;
    cause?: unknown;
  }) {
    super(
      "CONFLICT",
      args.remoteOnlyCommits === null
        ? `${args.remoteRef} moved while its commits were checked — nothing was pushed; retry`
        : `${args.remoteRef} has ${args.remoteOnlyCommits} commit(s) the run branch does not — a push would drop them; update onto the publication first, or confirm replacing ${args.remoteHead}`,
      {
        details: { reason: "publication_diverged" },
        ...(args.cause === undefined ? {} : { cause: args.cause }),
      },
    );
    this.name = "PublicationDivergedError";
    this.remoteHead = args.remoteHead;
    this.remoteRef = args.remoteRef;
    this.remoteOnlyCommits = args.remoteOnlyCommits;
    Object.setPrototypeOf(this, PublicationDivergedError.prototype);
  }
}

// Every force-push of a run branch asks this first. `confirmedHead` is a
// human's confirmation of exactly `remoteHead`; automation passes none, so its
// drop is always refused.
export async function assertPushKeepsPublication(args: {
  runId: string;
  // The parent clone: the refs and objects the count reads.
  repo: string;
  // The run branch the push would put on the remote, as it stands now.
  localBranch: string;
  remote: string;
  remoteBranch: string;
  // The lease head `ls-remote` read; null when the ref is absent.
  remoteHead: string | null;
  // Refs the pushed result will contain (the update's base or target).
  keptRefs: readonly string[];
  // Remotes whose refs the count needs locally.
  fetchRemotes: readonly string[];
  confirmedHead?: string | null;
}): Promise<void> {
  if (args.remoteHead === null) return;

  const remoteRef = `${args.remote}/${args.remoteBranch}`;

  for (const name of new Set(args.fetchRemotes)) {
    await fetchRemote({ projectRepoPath: args.repo, name });
  }

  let dropped: number;

  try {
    dropped = await remoteOnlyCommitCount({
      projectRepoPath: args.repo,
      localBranch: args.localBranch,
      remoteSha: args.remoteHead,
      keptRefs: args.keptRefs,
    });
  } catch (err) {
    if (isMaisterError(err) && err.code === "CONFLICT") {
      throw new PublicationDivergedError({
        remoteHead: null,
        remoteRef,
        remoteOnlyCommits: null,
        cause: err,
      });
    }
    throw err;
  }

  if (dropped === 0) return;

  if (args.confirmedHead === args.remoteHead) {
    log.warn(
      { runId: args.runId, remoteRef, remoteHead: args.remoteHead, dropped },
      "a confirmed push drops commits only the publication had",
    );

    return;
  }

  log.info(
    { runId: args.runId, remoteRef, remoteHead: args.remoteHead, dropped },
    "push refused: it would drop commits only the publication has",
  );

  throw new PublicationDivergedError({
    remoteHead: args.remoteHead,
    remoteRef,
    remoteOnlyCommits: dropped,
  });
}
