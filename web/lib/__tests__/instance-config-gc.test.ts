// M19 Phase 1 (T1.C): GC tunables in instance-config. gcAgeDays() drives
// how long after endedAt an Abandoned/Done workspace is scheduled for
// removal; gcWarningDays() drives the pre-removal warning window. Both
// mirror the sweepIntervalSeconds() parser shape: env override, sane
// default, floor at 1.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gcAgeDays, gcWarningDays } from "@/lib/instance-config";

const ENV_KEYS = ["MAISTER_GC_AGE_DAYS", "MAISTER_GC_WARNING_DAYS"] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe("gcAgeDays", () => {
  it("defaults to 14 when unset", () => {
    expect(gcAgeDays()).toBe(14);
  });

  it("returns the env override when valid", () => {
    process.env.MAISTER_GC_AGE_DAYS = "30";

    expect(gcAgeDays()).toBe(30);
  });

  it("falls back to 14 on a non-numeric value", () => {
    process.env.MAISTER_GC_AGE_DAYS = "abc";

    expect(gcAgeDays()).toBe(14);
  });

  it("falls back to 14 when below the floor of 1", () => {
    process.env.MAISTER_GC_AGE_DAYS = "0";

    expect(gcAgeDays()).toBe(14);
  });

  it("accepts the minimum of 1", () => {
    process.env.MAISTER_GC_AGE_DAYS = "1";

    expect(gcAgeDays()).toBe(1);
  });
});

describe("gcWarningDays", () => {
  it("defaults to 2 when unset", () => {
    expect(gcWarningDays()).toBe(2);
  });

  it("returns the env override when valid", () => {
    process.env.MAISTER_GC_WARNING_DAYS = "5";

    expect(gcWarningDays()).toBe(5);
  });

  it("falls back to 2 on a non-numeric value", () => {
    process.env.MAISTER_GC_WARNING_DAYS = "nope";

    expect(gcWarningDays()).toBe(2);
  });

  it("falls back to 2 when below the floor of 1", () => {
    process.env.MAISTER_GC_WARNING_DAYS = "-3";

    expect(gcWarningDays()).toBe(2);
  });

  it("accepts the minimum of 1", () => {
    process.env.MAISTER_GC_WARNING_DAYS = "1";

    expect(gcWarningDays()).toBe(1);
  });
});
