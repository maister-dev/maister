import { promotionClaimTimeoutSeconds } from "@/lib/instance-config";

/**
 * Whether a HELD workspace lifecycle claim (sync/stop/archive/…) has gone stale.
 *
 * Shared rather than duplicated per fence ON PURPOSE. Three fences key on this slot
 * — promote's reverse fence, sync's forward fence, and `canReclaimLifecycle` in the
 * workbench lifecycle service — and they must never disagree about who still owns
 * it: a fence that refuses while the service happily steals the same slot hands two
 * owners the same worktree. Each fence carrying its own copy of the timeout rule is
 * how that drift starts.
 *
 * It reads `claimed_at` as "last known alive", which is what the sync driver's
 * heartbeat maintains and what the reclaim window already assumes. A claim with no
 * timestamp is stale by definition — there is nothing asserting it is alive.
 */
export function lifecycleClaimIsStale(workspace: {
  lifecycleOperationClaimedAt?: Date | null;
}): boolean {
  const claimedAt = workspace.lifecycleOperationClaimedAt
    ? new Date(workspace.lifecycleOperationClaimedAt)
    : null;

  if (!claimedAt) return true;

  return (
    claimedAt.getTime() < Date.now() - promotionClaimTimeoutSeconds() * 1000
  );
}
