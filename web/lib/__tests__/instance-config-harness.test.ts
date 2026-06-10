import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  harnessNeverFiredMin,
  nodeOutputMaxBytes,
} from "@/lib/instance-config";

const ENV_KEYS = [
  "MAISTER_NODE_OUTPUT_MAX_BYTES",
  "MAISTER_HARNESS_NEVER_FIRED_MIN",
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

describe("nodeOutputMaxBytes", () => {
  it("defaults to 262144 when unset", () => {
    expect(nodeOutputMaxBytes()).toBe(262_144);
  });

  it("returns the parsed value when set to a positive integer", () => {
    process.env.MAISTER_NODE_OUTPUT_MAX_BYTES = "1048576";

    expect(nodeOutputMaxBytes()).toBe(1_048_576);
  });

  it("falls back to the default on a non-numeric value", () => {
    process.env.MAISTER_NODE_OUTPUT_MAX_BYTES = "garbage";

    expect(nodeOutputMaxBytes()).toBe(262_144);
  });

  it("falls back to the default on zero", () => {
    process.env.MAISTER_NODE_OUTPUT_MAX_BYTES = "0";

    expect(nodeOutputMaxBytes()).toBe(262_144);
  });

  it("falls back to the default on a negative value", () => {
    process.env.MAISTER_NODE_OUTPUT_MAX_BYTES = "-1";

    expect(nodeOutputMaxBytes()).toBe(262_144);
  });
});

describe("harnessNeverFiredMin", () => {
  it("defaults to 10 when unset", () => {
    expect(harnessNeverFiredMin()).toBe(10);
  });

  it("returns the parsed value when set to a positive integer", () => {
    process.env.MAISTER_HARNESS_NEVER_FIRED_MIN = "25";

    expect(harnessNeverFiredMin()).toBe(25);
  });

  it("falls back to the default on a non-numeric value", () => {
    process.env.MAISTER_HARNESS_NEVER_FIRED_MIN = "not-a-number";

    expect(harnessNeverFiredMin()).toBe(10);
  });

  it("falls back to the default on zero or below", () => {
    process.env.MAISTER_HARNESS_NEVER_FIRED_MIN = "0";

    expect(harnessNeverFiredMin()).toBe(10);
  });
});
