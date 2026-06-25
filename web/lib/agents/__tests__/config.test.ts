import type { AgentConfigParam } from "@/lib/agents/definition";

import { describe, expect, it } from "vitest";

import {
  resolveAgentConfig,
  validateInstanceConfig,
} from "@/lib/agents/config";

const DECLARED: AgentConfigParam[] = [
  { key: "detect_duplicates", type: "boolean", default: true },
  {
    key: "intake_mode",
    type: "enum",
    values: ["triage_only", "clarify"],
    default: "clarify",
  },
  { key: "max_rounds", type: "number", default: 3 },
  { key: "no_default", type: "string" },
];

describe("resolveAgentConfig", () => {
  it("returns all declared defaults when the instance is null", () => {
    expect(resolveAgentConfig(DECLARED, null)).toEqual({
      detect_duplicates: true,
      intake_mode: "clarify",
      max_rounds: 3,
    });
  });

  it("lets an instance value override the declared default", () => {
    expect(
      resolveAgentConfig(DECLARED, { intake_mode: "triage_only" }),
    ).toEqual({
      detect_duplicates: true,
      intake_mode: "triage_only",
      max_rounds: 3,
    });
  });

  it("merges a partial instance — set key overridden, others default", () => {
    expect(resolveAgentConfig(DECLARED, { detect_duplicates: false })).toEqual({
      detect_duplicates: false,
      intake_mode: "clarify",
      max_rounds: 3,
    });
  });

  it("ignores an unknown instance key (does not crash, not in result)", () => {
    expect(
      resolveAgentConfig(DECLARED, { not_declared: "x", max_rounds: 9 }),
    ).toEqual({
      detect_duplicates: true,
      intake_mode: "clarify",
      max_rounds: 9,
    });
  });

  it("includes a declared param with no default only when the instance sets it", () => {
    expect(resolveAgentConfig(DECLARED, null).no_default).toBeUndefined();
    expect(resolveAgentConfig(DECLARED, { no_default: "p" }).no_default).toBe(
      "p",
    );
  });

  it("returns an empty map for null/empty declarations", () => {
    expect(resolveAgentConfig(null, { x: 1 })).toEqual({});
    expect(resolveAgentConfig([], null)).toEqual({});
  });

  it("carries the instance value type through per declaration", () => {
    const resolved = resolveAgentConfig(DECLARED, { max_rounds: 5 });

    expect(typeof resolved.max_rounds).toBe("number");
    expect(typeof resolved.detect_duplicates).toBe("boolean");
  });
});

describe("validateInstanceConfig", () => {
  it("returns null for a valid instance (correct types + in-range enum)", () => {
    expect(
      validateInstanceConfig(DECLARED, {
        detect_duplicates: false,
        intake_mode: "triage_only",
        max_rounds: 5,
        no_default: "x",
      }),
    ).toBeNull();
  });

  it("returns null for an empty instance regardless of declarations", () => {
    expect(validateInstanceConfig(DECLARED, {})).toBeNull();
    expect(validateInstanceConfig(null, {})).toBeNull();
  });

  it("rejects an unknown key", () => {
    expect(validateInstanceConfig(DECLARED, { not_a_param: 1 })).toMatch(
      /unknown config key/,
    );
    expect(validateInstanceConfig(null, { anything: 1 })).toMatch(
      /unknown config key/,
    );
  });

  it("rejects an out-of-range enum value", () => {
    expect(validateInstanceConfig(DECLARED, { intake_mode: "bogus" })).toMatch(
      /must be one of/,
    );
  });

  it("rejects a wrong-typed scalar", () => {
    expect(
      validateInstanceConfig(DECLARED, { detect_duplicates: "yes" }),
    ).toMatch(/must be a boolean/);
    expect(validateInstanceConfig(DECLARED, { max_rounds: "3" })).toMatch(
      /must be a number/,
    );
    expect(validateInstanceConfig(DECLARED, { no_default: 4 })).toMatch(
      /must be a string/,
    );
  });

  it("rejects a non-string enum value even when it would stringify", () => {
    expect(validateInstanceConfig(DECLARED, { intake_mode: 1 })).toMatch(
      /must be one of/,
    );
  });
});
