import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { flowYamlV1Schema } from "@/lib/config.schema";
import { buildAuthoredFlowDiff } from "@/lib/queries/authored-flow-diff";

function flow(prompt: string): FlowYamlV1 {
  return flowYamlV1Schema.parse({
    schemaVersion: 1,
    name: "Flow",
    nodes: [
      { id: "plan", type: "ai_coding", action: { prompt } },
      { id: "review", type: "human" },
    ],
  });
}

describe("buildAuthoredFlowDiff", () => {
  it("identical draft and published → empty diff", () => {
    const manifest = flow("do plan");
    const result = buildAuthoredFlowDiff(manifest, manifest, 3);

    expect(result.diff).toBe("");
    expect(result.kind).toBe("flow");
    expect(result.draftVersion).toBe(3);
    expect(result.draftYaml).toBe(result.publishedYaml);
  });

  it("differing draft → non-empty diff with both markers", () => {
    const result = buildAuthoredFlowDiff(flow("NEW"), flow("OLD"), 1);
    const lines = result.diff.split("\n");

    expect(result.diff).not.toBe("");
    // marker = line START (YAML list items also contain "- " mid-line)
    expect(lines.some((l) => l.startsWith("+ "))).toBe(true);
    expect(lines.some((l) => l.startsWith("- "))).toBe(true);
  });

  it("compiles both topologies for the side-by-side render", () => {
    const result = buildAuthoredFlowDiff(flow("a"), flow("b"), 1);

    expect(result.draftTopology.nodes.length).toBe(2);
    expect(result.publishedTopology?.nodes.length).toBe(2);
  });

  it("null published → empty published yaml, null topology, pure-add diff", () => {
    const result = buildAuthoredFlowDiff(flow("a"), null, 1);

    const lines = result.diff.split("\n");

    expect(result.publishedYaml).toBe("");
    expect(result.publishedTopology).toBeNull();
    expect(result.publishedLayout).toBeNull();
    // every line is an addition — pure add, no removal markers
    expect(lines.every((l) => l.startsWith("+ "))).toBe(true);
    expect(lines.some((l) => l.startsWith("- "))).toBe(false);
  });
});
