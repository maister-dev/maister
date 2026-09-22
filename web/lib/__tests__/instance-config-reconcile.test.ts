// M19 reconciliation grace tunable in instance-config.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reconcileGraceSeconds } from "@/lib/instance-config";

const ENV_KEYS = ["MAISTER_RECONCILE_GRACE_SECONDS"] as const;

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
