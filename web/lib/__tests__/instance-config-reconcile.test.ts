// M19 Phase 2 (T2.3): reconcile tunables in instance-config.
//   * reconcileSweepIntervalSeconds() — env MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS,
//     default 60, floor 1.
//   * reconcileGraceSeconds() — env MAISTER_RECONCILE_GRACE_SECONDS,
//     default 90, floor 1.
// Both mirror the gcAgeDays() parser shape: env override, sane default, floor
// at 1 (invalid/non-numeric/below-floor → default).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  reconcileGraceSeconds,
  reconcileSweepIntervalSeconds,
} from "@/lib/instance-config";

const ENV_KEYS = [
  "MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS",
  "MAISTER_RECONCILE_GRACE_SECONDS",
] as const;

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

describe("reconcileSweepIntervalSeconds", () => {
  it("defaults to 60 when unset", () => {
    expect(reconcileSweepIntervalSeconds()).toBe(60);
  });

  it("returns the env override when valid", () => {
    process.env.MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS = "120";

    expect(reconcileSweepIntervalSeconds()).toBe(120);
  });

  it("falls back to 60 on a non-numeric value", () => {
    process.env.MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS = "abc";

    expect(reconcileSweepIntervalSeconds()).toBe(60);
  });

  it("falls back to 60 when below the floor of 1", () => {
    process.env.MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS = "0";

    expect(reconcileSweepIntervalSeconds()).toBe(60);
  });

  it("accepts the minimum of 1", () => {
    process.env.MAISTER_RECONCILE_SWEEP_INTERVAL_SECONDS = "1";

    expect(reconcileSweepIntervalSeconds()).toBe(1);
  });
});

describe("reconcileGraceSeconds", () => {
  it("defaults to 90 when unset", () => {
    expect(reconcileGraceSeconds()).toBe(90);
  });

  it("returns the env override when valid", () => {
    process.env.MAISTER_RECONCILE_GRACE_SECONDS = "30";

    expect(reconcileGraceSeconds()).toBe(30);
  });

  it("falls back to 90 on a non-numeric value", () => {
    process.env.MAISTER_RECONCILE_GRACE_SECONDS = "nope";

    expect(reconcileGraceSeconds()).toBe(90);
  });

  it("falls back to 90 when below the floor of 1", () => {
    process.env.MAISTER_RECONCILE_GRACE_SECONDS = "-5";

    expect(reconcileGraceSeconds()).toBe(90);
  });

  it("accepts the minimum of 1", () => {
    process.env.MAISTER_RECONCILE_GRACE_SECONDS = "1";

    expect(reconcileGraceSeconds()).toBe(1);
  });
});
