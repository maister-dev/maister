import "server-only";

import pino from "pino";

import { logRange, resolveRefSha } from "@/lib/worktree";

const log = pino({
  name: "claim-head",
  level: process.env.LOG_LEVEL ?? "info",
});

/**
 * The branch HEAD at the instant a human claim is taken (ADR-030 takeover and
 * ADR-160 rework claim alike).
 *
 * Best-effort by design: a claim must not be refused because git could not
 * resolve a SHA. A null result degrades the return to the historical
 * merge-base count, which is exactly how claims taken before the column
 * existed behave.
 */
export async function captureClaimHead(args: {
  worktreePath: string;
  branch: string;
  runId: string;
}): Promise<string | null> {
  try {
    return await resolveRefSha(args.worktreePath, args.branch);
  } catch (err) {
    log.warn(
      {
        runId: args.runId,
        branch: args.branch,
        err: err instanceof Error ? err.message : String(err),
      },
      "[claim-head] could not resolve the claim-time HEAD — the return will fall back to the merge-base count",
    );

    return null;
  }
}

/**
 * How many commits the OPERATOR added while holding the claim.
 *
 * This is the only honest answer to "did they actually do anything". Counting
 * from the project merge-base cannot answer it: a run that reached `Review`
 * already carries every commit its flow made, so that count is positive for a
 * claim where the operator changed nothing — which is precisely why the
 * "no commits to return" guard never fired in production.
 *
 * Returns null when there is no recorded claim head (a pre-column claim row, or
 * one whose SHA could not be read). Callers then fall back to the merge-base
 * count rather than guessing, because a wrong zero would refuse a return that
 * really did carry work.
 */
export async function countOperatorCommits(args: {
  worktreePath: string;
  branch: string;
  claimHeadSha: string | null | undefined;
  runId: string;
}): Promise<number | null> {
  if (!args.claimHeadSha) {
    log.warn(
      { runId: args.runId, branch: args.branch },
      "[claim-head] claim row has no claim_head_sha — falling back to the merge-base commit count",
    );

    return null;
  }

  try {
    const commits = await logRange({
      worktreePath: args.worktreePath,
      baseRef: args.claimHeadSha,
      branch: args.branch,
    });

    return commits.split("\n").filter((line) => line.length > 0).length;
  } catch (err) {
    // A rewritten or garbage-collected claim head is not a reason to strand the
    // operator's work: degrade to the merge-base count, same as a null head.
    log.warn(
      {
        runId: args.runId,
        branch: args.branch,
        claimHeadSha: args.claimHeadSha,
        err: err instanceof Error ? err.message : String(err),
      },
      "[claim-head] claim-time HEAD is unreachable — falling back to the merge-base commit count",
    );

    return null;
  }
}
