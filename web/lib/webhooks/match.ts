import "server-only";

/**
 * Subscription matching over TWO independent scope axes (ADR-172 D3).
 *
 * Before the widening this was one nullable field: a subscription with
 * `projectId === null` meant "platform-wide, matches every project", and the
 * predicate read
 *
 *   sub.projectId === null || sub.projectId === event.projectId
 *
 * Once `webhook_events.project_id` became nullable too, that first disjunct
 * would make **every platform-wide subscription match every user event** — an
 * operator who subscribed to platform-wide run activity would start receiving
 * other people's personal attention notifications. One expression cannot carry
 * two independent axes; so it does not.
 */

export interface MatchableEvent {
  type: string;
  /** `null` for a user-scoped `attention.*` event. */
  projectId: string | null;
  /** The owner a user-scoped event belongs to; `null` for a project event. */
  ownerUserId?: string | null;
}

export interface MatchableSubscription {
  id: string;
  /** `null` means platform-wide among NON-user subscriptions. */
  projectId: string | null;
  /** Non-null makes the subscription user-scoped. */
  ownerUserId?: string | null;
  enabled: boolean;
  eventTypes: string[];
}

/**
 * The scope axes, resolved independently:
 *
 * - A **user-scoped** event (`ownerUserId` set) matches ONLY the subscription
 *   owned by that user. Never a platform-wide one, never a project one.
 * - A **project-scoped** event matches project-scoped and platform-wide
 *   subscriptions, and NEVER a user subscription — a subscription with an owner
 *   is a person's, whatever its project column happens to say.
 *
 * Both directions are contractual (`NTF-03`) and both are tested; getting only
 * one right is the failure mode that leaks.
 */
function scopeMatches(
  event: MatchableEvent,
  sub: MatchableSubscription,
): boolean {
  const eventOwner = event.ownerUserId ?? null;
  const subOwner = sub.ownerUserId ?? null;

  if (eventOwner !== null) return subOwner === eventOwner;
  if (subOwner !== null) return false;

  return sub.projectId === null || sub.projectId === event.projectId;
}

export function subscriptionMatches(
  event: MatchableEvent,
  sub: MatchableSubscription,
): boolean {
  const typeOk =
    sub.eventTypes.includes("*") || sub.eventTypes.includes(event.type);

  return sub.enabled && scopeMatches(event, sub) && typeOk;
}

export function matchSubscriptions<S extends MatchableSubscription>(
  event: MatchableEvent,
  subs: readonly S[],
): S[] {
  return subs.filter((s) => subscriptionMatches(event, s));
}
