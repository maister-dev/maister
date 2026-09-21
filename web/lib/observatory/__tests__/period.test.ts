import { describe, expect, it } from "vitest";

import { resolveObservatoryPeriod } from "@/lib/observatory/period";

const NOW = new Date("2026-06-05T12:00:00.000Z");

describe("resolveObservatoryPeriod (ADR-178 D1)", () => {
  it("defaults to a 30-day preset aligned to whole UTC days", () => {
    const period = resolveObservatoryPeriod({ now: NOW });

    expect(period.since.toISOString()).toBe("2026-05-07T00:00:00.000Z");
    expect(period.until.toISOString()).toBe("2026-06-06T00:00:00.000Z");
    expect(period.preset).toBe(30);
    expect(period.windowDays).toBe(30);
    expect(period.from).toBeUndefined();
    expect(period.to).toBeUndefined();
    expect(period.clamped).toBe(false);
  });

  it("aligns each preset to 00:00Z of its first day", () => {
    expect(
      resolveObservatoryPeriod({
        now: NOW,
        windowDays: "7",
      }).since.toISOString(),
    ).toBe("2026-05-30T00:00:00.000Z");
    expect(
      resolveObservatoryPeriod({
        now: NOW,
        windowDays: "90",
      }).since.toISOString(),
    ).toBe("2026-03-08T00:00:00.000Z");
    // `until` is the same exclusive bound for every preset.
    for (const windowDays of ["7", "30", "90"]) {
      expect(
        resolveObservatoryPeriod({ now: NOW, windowDays }).until.toISOString(),
      ).toBe("2026-06-06T00:00:00.000Z");
    }
  });

  it("marks a non-preset window size as preset null while keeping the span", () => {
    const period = resolveObservatoryPeriod({ now: NOW, windowDays: "14" });

    expect(period.preset).toBeNull();
    expect(period.windowDays).toBe(14);
    expect(period.since.toISOString()).toBe("2026-05-23T00:00:00.000Z");
  });

  it("clamps an oversized windowDays to 365 and a non-positive one to 1", () => {
    const huge = resolveObservatoryPeriod({ now: NOW, windowDays: "999" });

    expect(huge.windowDays).toBe(365);
    expect(huge.since.toISOString()).toBe("2025-06-06T00:00:00.000Z");

    const tiny = resolveObservatoryPeriod({ now: NOW, windowDays: "0" });

    expect(tiny.windowDays).toBe(1);
    expect(tiny.since.toISOString()).toBe("2026-06-05T00:00:00.000Z");
  });

  it("falls back to the default when windowDays is not a number", () => {
    const period = resolveObservatoryPeriod({ now: NOW, windowDays: "abc" });

    expect(period.windowDays).toBe(30);
    expect(period.preset).toBe(30);
  });

  it("resolves a custom range with an inclusive `to`", () => {
    const period = resolveObservatoryPeriod({
      now: NOW,
      from: "2026-05-01",
      to: "2026-05-31",
    });

    expect(period.since.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(period.until.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(period.preset).toBeNull();
    expect(period.from).toBe("2026-05-01");
    expect(period.to).toBe("2026-05-31");
    expect(period.clamped).toBe(false);
  });

  it("accepts a single-day custom range", () => {
    const period = resolveObservatoryPeriod({
      now: NOW,
      from: "2026-05-04",
      to: "2026-05-04",
    });

    expect(period.since.toISOString()).toBe("2026-05-04T00:00:00.000Z");
    expect(period.until.toISOString()).toBe("2026-05-05T00:00:00.000Z");
  });

  it("lets the custom range win when a preset is also present", () => {
    const period = resolveObservatoryPeriod({
      now: NOW,
      windowDays: "7",
      from: "2026-05-01",
      to: "2026-05-31",
    });

    expect(period.since.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(period.until.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(period.preset).toBeNull();
  });

  it("drops the custom range when from > to and applies the preset default", () => {
    const period = resolveObservatoryPeriod({
      now: NOW,
      from: "2026-05-31",
      to: "2026-05-01",
    });

    expect(period.since.toISOString()).toBe("2026-05-07T00:00:00.000Z");
    expect(period.until.toISOString()).toBe("2026-06-06T00:00:00.000Z");
    expect(period.preset).toBe(30);
    expect(period.from).toBeUndefined();
    expect(period.to).toBeUndefined();
  });

  it("drops the custom range when either bound is unparsable or half-present", () => {
    for (const input of [
      { from: "2026-13-45", to: "2026-05-31" },
      { from: "2026-05-01", to: "not-a-date" },
      { from: "2026-02-30", to: "2026-03-05" },
      { from: "2026-05-01" },
      { to: "2026-05-31" },
    ]) {
      const period = resolveObservatoryPeriod({ now: NOW, ...input });

      expect(period.preset).toBe(30);
      expect(period.from).toBeUndefined();
      expect(period.to).toBeUndefined();
      expect(period.since.toISOString()).toBe("2026-05-07T00:00:00.000Z");
    }
  });

  it("clamps a 400-day custom span by moving `since` forward", () => {
    const period = resolveObservatoryPeriod({
      now: NOW,
      from: "2025-05-01",
      to: "2026-06-04",
    });

    expect(period.until.toISOString()).toBe("2026-06-05T00:00:00.000Z");
    // 365 whole days back from the exclusive bound.
    expect(period.since.toISOString()).toBe("2025-06-05T00:00:00.000Z");
    expect(period.clamped).toBe(true);
    // The bar renders the EFFECTIVE values, not the requested ones.
    expect(period.from).toBe("2025-06-05");
    expect(period.to).toBe("2026-06-04");
  });

  it("does not clamp a span of exactly 365 days", () => {
    const period = resolveObservatoryPeriod({
      now: NOW,
      from: "2025-06-06",
      to: "2026-06-04",
    });

    expect(period.clamped).toBe(false);
    expect(period.since.toISOString()).toBe("2025-06-06T00:00:00.000Z");
  });

  it("reads `now` only from its input — never the wall clock", () => {
    const other = new Date("2020-01-15T08:00:00.000Z");
    const period = resolveObservatoryPeriod({ now: other, windowDays: "7" });

    expect(period.since.toISOString()).toBe("2020-01-09T00:00:00.000Z");
    expect(period.until.toISOString()).toBe("2020-01-16T00:00:00.000Z");
  });

  it("does not mutate the caller's `now`", () => {
    const now = new Date("2026-06-05T12:00:00.000Z");

    resolveObservatoryPeriod({ now, windowDays: "90" });

    expect(now.toISOString()).toBe("2026-06-05T12:00:00.000Z");
  });
});
