import "server-only";

import { branchHasUpstream } from "@/lib/worktree";

// THE published predicate (ADR-141). A run branch is published iff origin
// already carries it — which is exactly the condition under which a sync must
// force-with-lease push, and therefore exactly what the UI's "push" checkbox
// must be seeded from (`input.push ?? published`).
//
// `pr_url` counts on its OWN: a PR cannot exist unless the branch was pushed,
// while the upstream tracking ref is local git config that a worktree recreated
// by recovery or reopen simply may not have. Reading only the tracking ref (as
// the review panel did) shows "push" OFF for a run with an open PR — so the sync
// silently does not push, and the PR keeps the pre-sync commits.
//
// Lives in one place, imported by both the code that PERFORMS the push and the
// code that renders the flag for it, so the two cannot drift again. Callers that
// must degrade rather than fail (recovery, panel rendering) apply their own
// `.catch` — the live sync path deliberately does NOT, since silently deciding
// "not published" would turn a missed push into a reported success.
export async function isBranchPublished(args: {
  prUrl: string | null;
  repo: string;
  branch: string;
}): Promise<boolean> {
  return args.prUrl != null || (await branchHasUpstream(args.repo, args.branch));
}
