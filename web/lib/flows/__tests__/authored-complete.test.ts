import { describe, expect, it } from "vitest";

import {
  FLOW_STEP_TYPES,
  flowYamlCompletions,
} from "@/lib/flows/authored-complete";

// Contract chosen (and asserted consistently below): flowYamlCompletions is a
// prefix filter over the static flow.yaml vocab (step types + known top-level
// manifest keys + static runner-profile keys). Case-insensitive. An empty
// prefix returns the full vocab; a prefix with no match returns [].

describe("FLOW_STEP_TYPES", () => {
  it("is exactly the four step kinds", () => {
    expect([...FLOW_STEP_TYPES].sort()).toEqual(
      ["agent", "cli", "guard", "human"].sort(),
    );
  });
});

describe("flowYamlCompletions", () => {
  it("resolves a step-type prefix to the matching kind", () => {
    expect(flowYamlCompletions("ag")).toContain("agent");
    expect(flowYamlCompletions("hum")).toContain("human");
  });

  it("includes the known top-level flow.yaml manifest keys", () => {
    const all = flowYamlCompletions("");

    for (const key of ["schemaVersion", "name", "steps", "nodes"]) {
      expect(all).toContain(key);
    }
  });

  it("surfaces the four step types in the full vocab", () => {
    const all = flowYamlCompletions("");

    for (const stepType of FLOW_STEP_TYPES) {
      expect(all).toContain(stepType);
    }
  });

  it("returns an empty list for an unknown prefix", () => {
    expect(flowYamlCompletions("zzz-no-such-token")).toEqual([]);
  });

  it("returns deduplicated, non-empty options only", () => {
    const all = flowYamlCompletions("");

    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all).size).toBe(all.length);

    for (const option of all) {
      expect(option.length).toBeGreaterThan(0);
    }
  });
});
