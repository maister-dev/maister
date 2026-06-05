import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { compileManifest } from "@/lib/flows/graph/compile";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";

// A linear `steps[]` manifest. The linear compiler chains each step by the
// `success` outcome (compile.ts: transitions = { success: next }); the last
// step targets the terminal "done" sentinel, which must be OMITTED as an edge.
const linear: FlowYamlV1 = {
  schemaVersion: 1,
  name: "greet",
  steps: [
    { id: "hello", type: "cli", command: "echo hi" },
    { id: "plan", type: "agent", mode: "new-session", prompt: "/aif-plan" },
    { id: "review", type: "human", form_schema: "./r.json" },
  ],
} as FlowYamlV1;

// A graph `nodes[]` manifest. `review` has a multi-outcome transition map:
// approve -> "done" (terminal, omitted) and rework -> implement (a real edge).
const graph: FlowYamlV1 = {
  schemaVersion: 1,
  name: "aif",
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

describe("buildGraphTopology — linear steps[]", () => {
  it("emits one node per step, in compiled order", () => {
    const topo = buildGraphTopology(compileManifest(linear));

    expect(topo.nodes.map((n) => n.id)).toEqual(["hello", "plan", "review"]);
  });

  it("emits N-1 success edges and omits the terminal 'done' edge", () => {
    const topo = buildGraphTopology(compileManifest(linear));

    expect(topo.edges).toEqual([
      {
        id: "hello:success",
        source: "hello",
        target: "plan",
        outcome: "success",
      },
      {
        id: "plan:success",
        source: "plan",
        target: "review",
        outcome: "success",
      },
    ]);
  });

  it("carries each node's nodeType from the compiled node", () => {
    const topo = buildGraphTopology(compileManifest(linear));

    expect(topo.nodes.map((n) => n.nodeType)).toEqual([
      "cli",
      "ai_coding",
      "human",
    ]);
  });
});

describe("buildGraphTopology — graph nodes[] with multi-outcome transitions", () => {
  it("emits one edge per non-'done' outcome with correct source/target/outcome", () => {
    const topo = buildGraphTopology(compileManifest(graph));

    expect(topo.edges).toEqual([
      {
        id: "implement:success",
        source: "implement",
        target: "review",
        outcome: "success",
      },
      {
        id: "review:rework",
        source: "review",
        target: "implement",
        outcome: "rework",
      },
    ]);
  });

  it("omits the 'done' (terminal) outcome from the review node", () => {
    const topo = buildGraphTopology(compileManifest(graph));

    expect(topo.edges.some((e) => e.target === "done")).toBe(false);
    expect(topo.edges.some((e) => e.outcome === "approve")).toBe(false);
  });
});

describe("buildGraphTopology — node label is the node id", () => {
  // The step/node DSL declares no label field (engine 1.2.0); the topology
  // label is always the node id (a human-readable label is a Wave-3 concern).
  it("labels each linear-step node by its id", () => {
    const topo = buildGraphTopology(compileManifest(linear));

    expect(topo.nodes.map((n) => n.label)).toEqual(["hello", "plan", "review"]);
    expect(topo.nodes.every((n) => n.label === n.id)).toBe(true);
  });

  it("labels each graph-form node by its id", () => {
    const topo = buildGraphTopology(compileManifest(graph));

    expect(topo.nodes.every((n) => n.label === n.id)).toBe(true);
  });
});

describe("buildGraphTopology — node order follows compiled.order", () => {
  it("preserves the manifest declaration order from compiled.order", () => {
    const topo = buildGraphTopology(compileManifest(graph));

    expect(topo.nodes.map((n) => n.id)).toEqual(["implement", "review"]);
  });
});
