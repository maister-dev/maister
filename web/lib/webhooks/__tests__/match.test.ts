import { describe, expect, it } from "vitest";

import {
  type MatchableEvent,
  type MatchableSubscription,
  matchSubscriptions,
  subscriptionMatches,
} from "@/lib/webhooks/match";

// =============================================================================
// T5 — outbound-webhooks subscription matching (TDD red).
//
// Pins the match predicate from docs/system-analytics/outbound-webhooks.md
// ("matchSubscriptions: enabled + scope + type incl. '*'"):
//   - enabled === true is required (disabled never matches).
//   - scope: sub.projectId === null → platform scope (matches ANY project);
//     else sub.projectId === event.projectId.
//   - type: sub.eventTypes includes "*" OR includes event.type.
//   matchSubscriptions returns the matching subset, preserving input order.
//   Module `@/lib/webhooks/match` does not exist yet — these MUST fail with
//   module-not-found until it lands verbatim against the pinned signature.
// =============================================================================

function evt(type: string, projectId: string): MatchableEvent {
  return { type, projectId };
}

function sub(
  overrides: Partial<MatchableSubscription> & { id: string },
): MatchableSubscription {
  return {
    projectId: null,
    enabled: true,
    eventTypes: ["*"],
    ...overrides,
  };
}

describe("subscriptionMatches — enabled gate", () => {
  it("does not match when enabled=false even though scope+type match", () => {
    const s = sub({
      id: "s1",
      projectId: "p1",
      enabled: false,
      eventTypes: ["run.done"],
    });

    expect(subscriptionMatches(evt("run.done", "p1"), s)).toBe(false);
  });

  it("a disabled platform '*' sub still does not match", () => {
    const s = sub({
      id: "s1",
      projectId: null,
      enabled: false,
      eventTypes: ["*"],
    });

    expect(subscriptionMatches(evt("run.done", "p1"), s)).toBe(false);
  });
});

describe("subscriptionMatches — scope", () => {
  it("platform sub (projectId=null) matches an event from any project", () => {
    const s = sub({ id: "s1", projectId: null, eventTypes: ["run.done"] });

    expect(subscriptionMatches(evt("run.done", "p1"), s)).toBe(true);
    expect(subscriptionMatches(evt("run.done", "p2"), s)).toBe(true);
  });

  it("project sub matches its own project and not another", () => {
    const s = sub({ id: "s1", projectId: "p1", eventTypes: ["run.done"] });

    expect(subscriptionMatches(evt("run.done", "p1"), s)).toBe(true);
    expect(subscriptionMatches(evt("run.done", "p2"), s)).toBe(false);
  });
});

describe("subscriptionMatches — type filter", () => {
  it("an exact eventType matches that type and not a different one", () => {
    const s = sub({ id: "s1", projectId: null, eventTypes: ["run.review"] });

    expect(subscriptionMatches(evt("run.review", "p1"), s)).toBe(true);
    expect(subscriptionMatches(evt("run.done", "p1"), s)).toBe(false);
  });

  it("'*' matches any type", () => {
    const s = sub({ id: "s1", projectId: null, eventTypes: ["*"] });

    expect(subscriptionMatches(evt("run.review", "p1"), s)).toBe(true);
    expect(subscriptionMatches(evt("run.done", "p1"), s)).toBe(true);
    expect(subscriptionMatches(evt("gate.decided", "p1"), s)).toBe(true);
  });

  it("a multi-type list matches any listed type and not a third", () => {
    const s = sub({
      id: "s1",
      projectId: null,
      eventTypes: ["run.done", "run.failed"],
    });

    expect(subscriptionMatches(evt("run.done", "p1"), s)).toBe(true);
    expect(subscriptionMatches(evt("run.failed", "p1"), s)).toBe(true);
    expect(subscriptionMatches(evt("run.review", "p1"), s)).toBe(false);
  });
});

describe("subscriptionMatches — combined", () => {
  it("project sub matches only when scope AND type both hold", () => {
    const s = sub({ id: "s1", projectId: "p1", eventTypes: ["run.done"] });

    expect(subscriptionMatches(evt("run.done", "p1"), s)).toBe(true);
    expect(subscriptionMatches(evt("run.failed", "p1"), s)).toBe(false);
    expect(subscriptionMatches(evt("run.done", "p2"), s)).toBe(false);
  });
});

describe("matchSubscriptions", () => {
  it("returns only matching subs, preserving input order", () => {
    const event = evt("run.done", "p1");
    const subs: MatchableSubscription[] = [
      sub({ id: "a", projectId: "p1", eventTypes: ["run.done"] }), // match
      sub({ id: "b", projectId: "p2", eventTypes: ["run.done"] }), // wrong scope
      sub({ id: "c", projectId: null, eventTypes: ["*"] }), // platform '*'
      sub({ id: "d", projectId: "p1", enabled: false, eventTypes: ["*"] }), // disabled
      sub({ id: "e", projectId: null, eventTypes: ["run.failed"] }), // wrong type
      sub({ id: "f", projectId: "p1", eventTypes: ["run.failed", "run.done"] }), // match
    ];

    const result = matchSubscriptions(event, subs);

    expect(result.map((r: MatchableSubscription) => r.id)).toEqual([
      "a",
      "c",
      "f",
    ]);
  });

  it("returns [] for empty input", () => {
    expect(matchSubscriptions(evt("run.done", "p1"), [])).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    const subs: MatchableSubscription[] = [
      sub({ id: "a", projectId: "p2", eventTypes: ["run.done"] }), // wrong scope
      sub({ id: "b", projectId: "p1", eventTypes: ["run.failed"] }), // wrong type
      sub({ id: "c", projectId: null, enabled: false, eventTypes: ["*"] }), // disabled
    ];

    expect(matchSubscriptions(evt("run.done", "p1"), subs)).toEqual([]);
  });

  it("preserves the original objects (returns the same references)", () => {
    const matching = sub({
      id: "a",
      projectId: "p1",
      eventTypes: ["run.done"],
    });
    const subs: MatchableSubscription[] = [matching];

    const result = matchSubscriptions(evt("run.done", "p1"), subs);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(matching);
  });
});
