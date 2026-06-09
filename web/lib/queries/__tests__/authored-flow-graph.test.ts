// RED test: `@/lib/queries/authored-flow-graph` does not exist yet.
// This file will fail with "Cannot find module" until T-A1 is implemented.
import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { buildAuthoredFlowGraph } from "@/lib/queries/authored-flow-graph";

// A minimal graph-form manifest with two nodes and a compat.engine_min
// declaration. Keeps the fixture small: one agent node transitions to one
// human review node; the human-approved edge is terminal ("done").
const manifest: FlowYamlV1 = {
  schemaVersion: 1,
  name: "authored-test-flow",
  compat: {
    engine_min: "1.2.0",
  },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "review" },
    },
    {
      id: "review",
      type: "human",
      finish: { human: { decisions: ["approve", "rework"] } },
      transitions: { approve: "done", rework: "implement" },
    },
  ],
} as FlowYamlV1;

describe("buildAuthoredFlowGraph — shape contract (T-A1)", () => {
  it("returns kind='flow'", () => {
    const result = buildAuthoredFlowGraph(manifest, 3);

    expect(result.kind).toBe("flow");
  });

  it("returns the supplied draftVersion", () => {
    const result = buildAuthoredFlowGraph(manifest, 3);

    expect(result.draftVersion).toBe(3);
  });

  it("topology.nodes contains an entry for each manifest node", () => {
    const result = buildAuthoredFlowGraph(manifest, 1);
    const nodeIds = result.topology.nodes.map((n) => n.id);

    expect(nodeIds).toContain("implement");
    expect(nodeIds).toContain("review");
    expect(result.topology.nodes).toHaveLength(2);
  });

  it("topology.edges contains the non-terminal transitions", () => {
    const result = buildAuthoredFlowGraph(manifest, 1);
    const edgeIds = result.topology.edges.map((e) => e.id);

    // implement:success → review (non-terminal)
    expect(edgeIds).toContain("implement:success");
    // review:rework → implement (non-terminal)
    expect(edgeIds).toContain("review:rework");
  });

  it("topology.edges omits the terminal 'done' outcome", () => {
    const result = buildAuthoredFlowGraph(manifest, 1);

    expect(result.topology.edges.every((e) => e.target !== "done")).toBe(true);
    expect(result.topology.edges.every((e) => e.outcome !== "approve")).toBe(
      true,
    );
  });

  it("layout is an object (may be empty for a manifest with no presentation section)", () => {
    const result = buildAuthoredFlowGraph(manifest, 1);

    expect(typeof result.layout).toBe("object");
    expect(result.layout).not.toBeNull();
  });

  it("layout carries authored coordinates when presentation section is present", () => {
    const manifWithLayout: FlowYamlV1 = {
      ...manifest,
      presentation: {
        nodes: [
          { id: "implement", x: 10, y: 20 },
          { id: "review", x: 10, y: 200 },
        ],
      },
    } as FlowYamlV1;
    const result = buildAuthoredFlowGraph(manifWithLayout, 1);

    expect(result.layout["implement"]).toEqual({ x: 10, y: 20 });
    expect(result.layout["review"]).toEqual({ x: 10, y: 200 });
  });

  it("topology.nodes carry nodeType and nodeRole for each node", () => {
    const result = buildAuthoredFlowGraph(manifest, 1);
    const byId = new Map(result.topology.nodes.map((n) => [n.id, n]));

    expect(byId.get("implement")?.nodeType).toBe("ai_coding");
    expect(byId.get("implement")?.nodeRole).toBe("agent");
    expect(byId.get("review")?.nodeType).toBe("human");
    expect(byId.get("review")?.nodeRole).toBe("human");
  });
});
