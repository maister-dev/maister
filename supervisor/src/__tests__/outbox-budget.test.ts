import type { PartitionUsage } from "../outbox-budget";

import { describe, expect, it } from "vitest";

import {
  retainedAtThreshold,
  unacknowledgedAtThreshold,
} from "../outbox-budget";

const zero: PartitionUsage = {
  retainedCount: 0,
  retainedBytes: 0,
  unacknowledgedCount: 0,
  unacknowledgedBytes: 0,
};

// ADR-183 D1/D3: the two predicates read disjoint lanes — pressure is the
// unacknowledged lane only, housekeeping and capacity are the retained lane.
describe("outbox budget predicates", () => {
  it.each([
    ["unacknowledgedCount", { unacknowledgedCount: 10 }, true, false],
    ["unacknowledgedBytes", { unacknowledgedBytes: 100 }, true, false],
    ["retainedCount", { retainedCount: 10 }, false, true],
    ["retainedBytes", { retainedBytes: 100 }, false, true],
  ] as const)(
    "%s at the threshold trips only its own predicate",
    (_lane, usage, unacknowledged, retained) => {
      const used = { ...zero, ...usage };

      expect(unacknowledgedAtThreshold(used, 100, 10)).toBe(unacknowledged);
      expect(retainedAtThreshold(used, 100, 10)).toBe(retained);
    },
  );

  it("is a >= comparison in both lanes", () => {
    const below = {
      retainedCount: 9,
      retainedBytes: 99,
      unacknowledgedCount: 9,
      unacknowledgedBytes: 99,
    };

    expect(unacknowledgedAtThreshold(below, 100, 10)).toBe(false);
    expect(retainedAtThreshold(below, 100, 10)).toBe(false);
  });
});
