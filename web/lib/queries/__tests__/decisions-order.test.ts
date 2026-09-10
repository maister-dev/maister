// UT-ATN-07 (ADR-168 D6) — the decision queue's order, as a pure comparator.
//
// Tested here rather than through the query on purpose: an ordering assertion
// that runs through a database fixture proves the fixture was inserted in some
// order at least as much as it proves the comparator, and it cannot cheaply
// cover the ranks that no fixture happens to produce.

import type { DecisionOrderKey } from "@/lib/queries/decisions";

import { describe, expect, it } from "vitest";

import { compareDecisions, decisionRank } from "@/lib/queries/decisions";

function key(overrides: Partial<DecisionOrderKey> = {}): DecisionOrderKey {
  return {
    kind: "hitl",
    criticality: null,
    since: new Date("2026-09-10T12:00:00.000Z"),
    id: "a",
    ...overrides,
  };
}

function sorted(keys: DecisionOrderKey[]): string[] {
  return [...keys].sort(compareDecisions).map((entry) => entry.id);
}

describe("UT-ATN-07 decision rank", () => {
  it("ranks HITL by its own criticality vocabulary", () => {
    expect(decisionRank({ kind: "hitl", criticality: "critical" })).toBe(3);
    expect(decisionRank({ kind: "hitl", criticality: "high" })).toBe(2);
    expect(decisionRank({ kind: "hitl", criticality: "medium" })).toBe(1);
    expect(decisionRank({ kind: "hitl", criticality: "low" })).toBe(0);
  });

  it("ranks a null criticality with medium — below raised, above lowered", () => {
    const nullRank = decisionRank({ kind: "hitl", criticality: null });

    expect(nullRank).toBe(
      decisionRank({ kind: "hitl", criticality: "medium" }),
    );
    expect(nullRank).toBeLessThan(
      decisionRank({ kind: "hitl", criticality: "high" }),
    );
    expect(nullRank).toBeGreaterThan(
      decisionRank({ kind: "hitl", criticality: "low" }),
    );
  });

  it("gives each non-HITL kind its fixed rank", () => {
    expect(decisionRank({ kind: "crashed", criticality: null })).toBe(2);
    expect(decisionRank({ kind: "promotable", criticality: null })).toBe(1);
    expect(decisionRank({ kind: "flagged", criticality: null })).toBe(0);
  });

  it("ignores a criticality carried by a non-HITL kind", () => {
    expect(decisionRank({ kind: "flagged", criticality: "critical" })).toBe(
      decisionRank({ kind: "flagged", criticality: null }),
    );
  });
});

describe("UT-ATN-07 decision ordering", () => {
  it("puts a higher rank first regardless of age", () => {
    expect(
      sorted([
        key({ id: "old-flagged", kind: "flagged", since: new Date(0) }),
        key({ id: "new-crash", kind: "crashed", since: new Date() }),
      ]),
    ).toEqual(["new-crash", "old-flagged"]);
  });

  it("breaks a rank tie by age, oldest first", () => {
    expect(
      sorted([
        key({ id: "younger", since: new Date("2026-09-10T12:00:00.000Z") }),
        key({ id: "older", since: new Date("2026-09-01T12:00:00.000Z") }),
      ]),
    ).toEqual(["older", "younger"]);
  });

  it("sorts an unknown age last within its rank, never first", () => {
    expect(
      sorted([
        key({ id: "undated", since: null }),
        key({ id: "dated", since: new Date("2026-09-10T12:00:00.000Z") }),
      ]),
    ).toEqual(["dated", "undated"]);
  });

  it("is total — equal rank and equal age still order deterministically", () => {
    const at = new Date("2026-09-10T12:00:00.000Z");
    const forward = sorted([
      key({ id: "b", since: at }),
      key({ id: "a", since: at }),
    ]);
    const reverse = sorted([
      key({ id: "a", since: at }),
      key({ id: "b", since: at }),
    ]);

    expect(forward).toEqual(reverse);
  });

  it("orders the four kinds crashed, promotable, flagged when no HITL competes", () => {
    expect(
      sorted([
        key({ id: "flagged", kind: "flagged" }),
        key({ id: "promotable", kind: "promotable" }),
        key({ id: "crashed", kind: "crashed" }),
      ]),
    ).toEqual(["crashed", "promotable", "flagged"]);
  });

  it("lets a critical HITL outrank a crashed run", () => {
    expect(
      sorted([
        key({ id: "crashed", kind: "crashed" }),
        key({ id: "critical", kind: "hitl", criticality: "critical" }),
      ]),
    ).toEqual(["critical", "crashed"]);
  });

  it("never consults a task priority — there is no field to consult", () => {
    const withPriority = { ...key({ id: "p" }), priority: "urgent" };

    expect(compareDecisions(withPriority, key({ id: "p" }))).toBe(0);
  });
});
