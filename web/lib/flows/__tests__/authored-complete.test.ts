import { describe, expect, it } from "vitest";

import {
  FLOW_NODE_TYPES,
  flowYamlCompletions,
} from "@/lib/flows/authored-complete";

// Contract chosen (and asserted consistently below): flowYamlCompletions is a
// prefix filter over the static flow.yaml vocab (node types + known top-level
// manifest keys + static runner-profile keys). Case-insensitive. An empty
// prefix returns the full vocab; a prefix with no match returns [].

describe("FLOW_NODE_TYPES", () => {
  it("is exactly the graph node kinds", () => {
    expect([...FLOW_NODE_TYPES].sort()).toEqual(
      [
        "ai_coding",
        "orchestrator",
        "consensus",
        "judge",
        "cli",
        "check",
        "human",
        "form",
      ].sort(),
    );
  });
});

describe("flowYamlCompletions", () => {
  it("resolves a node-type prefix to the matching kind", () => {
    expect(flowYamlCompletions("ai")).toContain("ai_coding");
    expect(flowYamlCompletions("hum")).toContain("human");
  });

  it("includes the known top-level flow.yaml manifest keys", () => {
    const all = flowYamlCompletions("");

    for (const key of ["schemaVersion", "name", "nodes"]) {
      expect(all).toContain(key);
    }
  });

  it("surfaces graph node types in the full vocab", () => {
    const all = flowYamlCompletions("");

    for (const nodeType of FLOW_NODE_TYPES) {
      expect(all).toContain(nodeType);
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
