import { describe, expect, it } from "vitest";

import {
  computeReplicateAggregate,
  computeTimingIntervals,
  costToSuccess,
  mean,
  percentile,
  variance,
} from "@/lib/evaluations/metrics";

describe("percentile / median / p90", () => {
  it("returns null for an empty set (missing, not zero)", () => {
    expect(percentile([], 50)).toBeNull();
    expect(mean([])).toBeNull();
    expect(variance([])).toBeNull();
  });

  it("computes median and p90 by interpolation", () => {
    const v = [1, 2, 3, 4, 5];

    expect(percentile(v, 50)).toBe(3);
    expect(percentile(v, 90)).toBeCloseTo(4.6, 5);
  });

  it("variance is 0 for a constant non-empty set (distinct from missing)", () => {
    expect(variance([4, 4, 4])).toBe(0);
  });
});

describe("computeReplicateAggregate", () => {
  it("counts all replicates but distributes only valid values", () => {
    const agg = computeReplicateAggregate([
      { value: 4, success: true },
      { value: null, success: false },
      { value: 2, success: true },
    ]);

    expect(agg.count).toBe(3);
    expect(agg.validCount).toBe(2);
    expect(agg.successCount).toBe(2);
    expect(agg.successRate).toBeCloseTo(2 / 3, 5);
    expect(agg.median).toBe(3);
    expect(agg.formulaVersion).toBe("1");
  });

  it("successRate is null for zero replicates (never fabricated)", () => {
    expect(computeReplicateAggregate([]).successRate).toBeNull();
  });
});

describe("costToSuccess", () => {
  it("is unavailable when cost is unpriced (never 0)", () => {
    const r = costToSuccess({ totalCostUsd: null, successCount: 3 });

    expect(r.value).toBeNull();
    expect(r.reason).toContain("pricing");
  });

  it("is unavailable when there are no successes", () => {
    expect(
      costToSuccess({ totalCostUsd: 9, successCount: 0 }).value,
    ).toBeNull();
  });

  it("divides priced cost by successes", () => {
    expect(costToSuccess({ totalCostUsd: 9, successCount: 3 }).value).toBe(3);
  });
});

describe("computeTimingIntervals", () => {
  it("returns null intervals for missing timestamps", () => {
    const t = computeTimingIntervals({});

    expect(t.wallMs).toBeNull();
    expect(t.queuedMs).toBeNull();
  });

  it("computes wall, queue, and active (wall minus HITL) intervals", () => {
    const t = computeTimingIntervals({
      enqueuedAt: 0,
      startedAt: 100,
      finishedAt: 1_100,
      hitlWaitMs: 400,
    });

    expect(t.queuedMs).toBe(100);
    expect(t.wallMs).toBe(1_000);
    expect(t.activeMs).toBe(600);
    expect(t.hitlWaitMs).toBe(400);
  });
});
