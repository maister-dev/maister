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
    // ADR-173: the second scope axis. `null` = not owned by a person, which is
    // what every pre-existing subscription is.
    ownerUserId: null,
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

// =============================================================================
// `UT-NTF-03` (ADR-173 D3) — scope is TWO independent axes, not one nullable
// field.
//
// The bug this pins is specific and it leaks. The old predicate was:
//
//   const scopeOk = sub.projectId === null || sub.projectId === event.projectId;
//
// `sub.projectId === null` means "platform-wide, matches every project". Once
// `event.projectId` can ALSO be null, that first disjunct makes every
// platform-wide subscription match every user event — a reader who subscribed
// to platform-wide run activity would start receiving other people's personal
// attention notifications.
//
// BOTH directions are asserted, because getting only one right is the failure
// mode that leaks.
// =============================================================================

function userEvt(type: string, ownerUserId: string): MatchableEvent {
  return { type, projectId: null, ownerUserId };
}

describe("UT-NTF-03 a project-scoped event never reaches a user subscription", () => {
  it("matches project-scoped and platform-wide subs, and not the user's", () => {
    const event = evt("run.done", "p1");

    expect(
      subscriptionMatches(
        event,
        sub({ id: "project", projectId: "p1", eventTypes: ["run.done"] }),
      ),
    ).toBe(true);
    expect(
      subscriptionMatches(
        event,
        sub({ id: "platform", projectId: null, eventTypes: ["run.done"] }),
      ),
    ).toBe(true);
    expect(
      subscriptionMatches(
        event,
        sub({
          id: "user",
          projectId: null,
          ownerUserId: "u1",
          eventTypes: ["run.done"],
        }),
      ),
    ).toBe(false);
  });

  it("does not reach a user sub even when the event names that project", () => {
    // A user subscription scoped to a project is still a USER subscription: the
    // owner axis is what excludes it, not the project axis.
    expect(
      subscriptionMatches(
        evt("run.done", "p1"),
        sub({
          id: "user",
          projectId: "p1",
          ownerUserId: "u1",
          eventTypes: ["*"],
        }),
      ),
    ).toBe(false);
  });
});

describe("UT-NTF-03 a user-scoped event reaches only its owner", () => {
  it("matches that owner's subscription", () => {
    expect(
      subscriptionMatches(
        userEvt("attention.digest", "u1"),
        sub({
          id: "mine",
          projectId: null,
          ownerUserId: "u1",
          eventTypes: ["attention.digest"],
        }),
      ),
    ).toBe(true);
  });

  it("NEVER matches a platform-wide subscription", () => {
    // The regression ADR-173 D3 exists to prevent: a platform-wide `*` sub is
    // the most common shape an operator creates, and it must not start
    // receiving other people's personal notifications.
    expect(
      subscriptionMatches(
        userEvt("attention.digest", "u1"),
        sub({ id: "platform", projectId: null, eventTypes: ["*"] }),
      ),
    ).toBe(false);
  });

  it("NEVER matches a project-scoped subscription", () => {
    expect(
      subscriptionMatches(
        userEvt("attention.digest", "u1"),
        sub({ id: "project", projectId: "p1", eventTypes: ["*"] }),
      ),
    ).toBe(false);
  });

  it("NEVER matches another owner's subscription", () => {
    expect(
      subscriptionMatches(
        userEvt("attention.digest", "u1"),
        sub({
          id: "theirs",
          projectId: null,
          ownerUserId: "u2",
          eventTypes: ["*"],
        }),
      ),
    ).toBe(false);
  });

  it("still respects the enabled gate and the type filter", () => {
    const event = userEvt("attention.digest", "u1");

    expect(
      subscriptionMatches(
        event,
        sub({
          id: "disabled",
          ownerUserId: "u1",
          enabled: false,
          eventTypes: ["*"],
        }),
      ),
    ).toBe(false);
    expect(
      subscriptionMatches(
        event,
        sub({
          id: "wrong-type",
          ownerUserId: "u1",
          eventTypes: ["attention.decision_opened"],
        }),
      ),
    ).toBe(false);
  });
});

describe("UT-NTF-03 matchSubscriptions over a mixed population", () => {
  it("routes a user event to exactly one of four candidate subs", () => {
    const subs: MatchableSubscription[] = [
      sub({ id: "platform", projectId: null, eventTypes: ["*"] }),
      sub({ id: "project", projectId: "p1", eventTypes: ["*"] }),
      sub({ id: "mine", ownerUserId: "u1", eventTypes: ["*"] }),
      sub({ id: "theirs", ownerUserId: "u2", eventTypes: ["*"] }),
    ];

    expect(
      matchSubscriptions(userEvt("attention.digest", "u1"), subs).map(
        (s) => s.id,
      ),
    ).toEqual(["mine"]);
    expect(
      matchSubscriptions(evt("run.done", "p1"), subs).map((s) => s.id),
    ).toEqual(["platform", "project"]);
  });
});
