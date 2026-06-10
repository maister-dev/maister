import "server-only";

export interface MatchableEvent {
  type: string;
  projectId: string;
}

export interface MatchableSubscription {
  id: string;
  projectId: string | null;
  enabled: boolean;
  eventTypes: string[];
}

export function subscriptionMatches(
  event: MatchableEvent,
  sub: MatchableSubscription,
): boolean {
  const scopeOk = sub.projectId === null || sub.projectId === event.projectId;
  const typeOk =
    sub.eventTypes.includes("*") || sub.eventTypes.includes(event.type);

  return sub.enabled && scopeOk && typeOk;
}

export function matchSubscriptions<S extends MatchableSubscription>(
  event: MatchableEvent,
  subs: readonly S[],
): S[] {
  return subs.filter((s) => subscriptionMatches(event, s));
}
