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

/**
 * The column set that RELEASES a workspace lifecycle claim.
 *
 * `workspaces_lifecycle_claim_shape_check` (migration `0116`) makes the claim a
 * SHAPE, not a flag: for `lifecycle_operation_state = 'none'`, `attempt_id`,
 * `name`, `expected_run_status`, and `lease_expires_at` must ALL be NULL (and
 * `claimed_at` with them, by the same convention). A release that clears only
 * some of them does not leave a half-released claim — the CHECK rejects the
 * UPDATE outright and the release THROWS.
 *
 * Declared once for the same reason `lifecycleClaimIsStale` is: four call sites
 * release a claim (workspace removal, the lifecycle-operation settle, the
 * sync-recovery sweep, and the terminal state transition), and two of them had
 * drifted to clearing four of the six columns — which broke every sync release
 * at the CHECK.
 */
export const RELEASED_LIFECYCLE_CLAIM = {
  lifecycleOperationState: "none",
  lifecycleOperationClaimedAt: null,
  lifecycleOperationLeaseExpiresAt: null,
  lifecycleOperationAttemptId: null,
  lifecycleOperationName: null,
  lifecycleOperationExpectedRunStatus: null,
} as const;

const LIFECYCLE_RECLAIMABLE_STATES = new Set(["none", "failed"]);

/**
 * Whether the workbench lifecycle slot may be claimed now: free, failed, or a
 * `claiming` whose LEASE lapsed. ADR-181 D1: the git policy's `busy` is exactly
 * the complement for a `claiming` slot, so the button and the claim agree.
 */
export function canReclaimLifecycle(workspace: {
  lifecycleOperationState?: string | null;
  lifecycleOperationLeaseExpiresAt?: Date | null;
}): boolean {
  const state = workspace.lifecycleOperationState ?? "none";

  if (LIFECYCLE_RECLAIMABLE_STATES.has(state)) return true;

  if (state === "claiming") {
    const leaseExpiresAt = workspace.lifecycleOperationLeaseExpiresAt
      ? new Date(workspace.lifecycleOperationLeaseExpiresAt)
      : null;

    if (!leaseExpiresAt) return true;

    return leaseExpiresAt.getTime() <= Date.now();
  }

  return false;
}

/**
 * ADR-181 C26: a PROMOTION claim that still owns the worktree — `claiming`
 * inside its window. Promotion's `canReclaim` and the lifecycle claim both read
 * this rule, so "one writer per worktree" holds in both directions.
 */
export function promotionClaimIsLive(workspace: {
  promotionState?: string | null;
  promotionClaimedAt?: Date | null;
}): boolean {
  if ((workspace.promotionState ?? "none") !== "claiming") return false;

  const claimedAt = workspace.promotionClaimedAt
    ? new Date(workspace.promotionClaimedAt)
    : null;

  if (!claimedAt) return false;

  return (
    claimedAt.getTime() >= Date.now() - promotionClaimTimeoutSeconds() * 1000
  );
}

/**
 * ADR-181 C26: whether a live workbench claim owns the worktree right now — a
 * lifecycle operation inside its lease, or a promotion inside its window. Both
 * recovers read it before they put an agent back into the tree; it is the rule
 * the git policy's `busy` and both claims apply, so none of them can disagree.
 */
export function workbenchClaimHoldsTree(workspace: {
  lifecycleOperationState?: string | null;
  lifecycleOperationLeaseExpiresAt?: Date | null;
  promotionState?: string | null;
  promotionClaimedAt?: Date | null;
}): boolean {
  return (
    ((workspace.lifecycleOperationState ?? "none") === "claiming" &&
      !canReclaimLifecycle(workspace)) ||
    promotionClaimIsLive(workspace)
  );
}
