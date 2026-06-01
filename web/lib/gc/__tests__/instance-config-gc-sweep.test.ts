// M19 Phase 4 (T4.5): GC-sweep tunables in instance-config.
// gcSweepIntervalSeconds() drives how often startGcSweeper()'s setInterval
// ticks (default 3600, min 1) — mirrors the existing parser shape (env
// override, sane default, floor at 1). gcArchivePush() is a boolean toggle
// (env === "true", default false) gating the optional `git push origin
// maister/archive/<runId>` in preserveWorktree.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gcArchivePush, gcSweepIntervalSeconds } from "@/lib/instance-config";

const ENV_KEYS = [
  "MAISTER_GC_SWEEP_INTERVAL_SECONDS",
  "MAISTER_GC_ARCHIVE_PUSH",
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

describe("gcSweepIntervalSeconds", () => {
  it("defaults to 3600 when unset", () => {
    expect(gcSweepIntervalSeconds()).toBe(3600);
  });

  it("returns the env override when valid", () => {
    process.env.MAISTER_GC_SWEEP_INTERVAL_SECONDS = "900";

    expect(gcSweepIntervalSeconds()).toBe(900);
  });

  it("falls back to 3600 on a non-numeric value", () => {
    process.env.MAISTER_GC_SWEEP_INTERVAL_SECONDS = "abc";

    expect(gcSweepIntervalSeconds()).toBe(3600);
  });

  it("falls back to 3600 when below the floor of 1", () => {
    process.env.MAISTER_GC_SWEEP_INTERVAL_SECONDS = "0";

    expect(gcSweepIntervalSeconds()).toBe(3600);
  });

  it("accepts the minimum of 1", () => {
    process.env.MAISTER_GC_SWEEP_INTERVAL_SECONDS = "1";

    expect(gcSweepIntervalSeconds()).toBe(1);
  });
});

describe("gcArchivePush", () => {
  it("defaults to false when unset", () => {
    expect(gcArchivePush()).toBe(false);
  });

  it('returns true only for the exact value "true"', () => {
    process.env.MAISTER_GC_ARCHIVE_PUSH = "true";

    expect(gcArchivePush()).toBe(true);
  });

  it('returns false for "1" (only "true" enables it)', () => {
    process.env.MAISTER_GC_ARCHIVE_PUSH = "1";

    expect(gcArchivePush()).toBe(false);
  });

  it("returns false for any other truthy-looking value", () => {
    process.env.MAISTER_GC_ARCHIVE_PUSH = "yes";

    expect(gcArchivePush()).toBe(false);
  });
});
