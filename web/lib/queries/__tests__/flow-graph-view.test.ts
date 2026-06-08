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

const visualGraph: FlowYamlV1 = {
  schemaVersion: 1,
  name: "visual-aif",
  nodes: [
    {
      id: "plan-work",
      type: "ai_coding",
      action: { prompt: "/aif-plan" },
      pre_finish: {
        gates: [
          {
            id: "unit-tests",
            kind: "command_check",
            mode: "blocking",
            command: "pnpm test",
          },
          {
            id: "style-check",
            kind: "skill_check",
            mode: "advisory",
            skill: "aif-review",
          },
        ],
      },
      transitions: { success: "review", custom_exit: "audit" },
    },
    {
      id: "review",
      type: "human",
      finish: { human: { decisions: ["approve", "rework", "takeover"] } },
      transitions: {
        approve: "done",
        rework: "plan-work",
        takeover: "plan-work",
      },
    },
    {
      id: "audit",
      type: "judge",
      action: { prompt: "/aif-review" },
      transitions: { success: "review" },
    },
  ],
} as FlowYamlV1;

// A graph with a `form` intake node (T4). The form node collects values against
// `settings.form_schema` and finishes on `transitions.success`.
const formGraph: FlowYamlV1 = {
  schemaVersion: 1,
  name: "intake-aif",
  nodes: [
    {
      id: "intake",
      type: "form",
      settings: { form_schema: "./schemas/intake.json" },
      transitions: { success: "plan" },
    },
    {
      id: "plan",
      type: "ai_coding",
      action: { prompt: "/aif-plan" },
      transitions: { success: "done" },
    },
  ],
} as FlowYamlV1;

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe("buildGraphTopology — linear steps[]", () => {
  it("emits one node per step, in compiled order", () => {
    const topo = buildGraphTopology(compileManifest(linear));

    expect(topo.nodes.map((n) => n.id)).toEqual(["hello", "plan", "review"]);
  });

  it("emits N-1 success edges and omits the terminal 'done' edge", () => {
    const topo = buildGraphTopology(compileManifest(linear));

    expect(topo.edges).toEqual([
      expect.objectContaining({
        id: "hello:success",
        source: "hello",
        target: "plan",
        outcome: "success",
      }),
      expect.objectContaining({
        id: "plan:success",
        source: "plan",
        target: "review",
        outcome: "success",
      }),
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
      expect.objectContaining({
        id: "implement:success",
        source: "implement",
        target: "review",
        outcome: "success",
      }),
      expect.objectContaining({
        id: "review:rework",
        source: "review",
        target: "implement",
        outcome: "rework",
      }),
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

describe("buildGraphTopology — visual metadata", () => {
  it("keeps label as id while exposing a human display label", () => {
    const topo = buildGraphTopology(compileManifest(visualGraph));
    const plan = asRecord(topo.nodes.find((n) => n.id === "plan-work"));

    expect(plan.label).toBe("plan-work");
    expect(plan.displayLabel).toBe("Plan work");
  });

  it("maps node types to stable roles and labels", () => {
    const topo = buildGraphTopology(compileManifest(visualGraph));
    const byId = new Map(topo.nodes.map((n) => [n.id, asRecord(n)]));

    expect(byId.get("plan-work")?.nodeRole).toBe("agent");
    expect(byId.get("plan-work")?.nodeTypeLabel).toBe("Agent");
    expect(byId.get("review")?.nodeRole).toBe("human");
    expect(byId.get("audit")?.nodeRole).toBe("judge");
  });

  it("maps a form intake node to the 'form' role and 'Form' label", () => {
    const topo = buildGraphTopology(compileManifest(formGraph));
    const byId = new Map(topo.nodes.map((n) => [n.id, asRecord(n)]));

    expect(byId.get("intake")?.nodeRole).toBe("form");
    expect(byId.get("intake")?.nodeTypeLabel).toBe("Form");
  });

  it("summarizes declared blocking/advisory gates without runtime status", () => {
    const topo = buildGraphTopology(compileManifest(visualGraph));
    const plan = asRecord(topo.nodes.find((n) => n.id === "plan-work"));

    expect(plan.declaredGateSummary).toEqual({
      total: 2,
      blocking: 1,
      advisory: 1,
      kinds: ["command_check", "skill_check"],
    });
  });

  it("labels known and custom edge outcomes with stable edge roles", () => {
    const topo = buildGraphTopology(compileManifest(visualGraph));
    const byId = new Map(topo.edges.map((e) => [e.id, asRecord(e)]));

    expect(byId.get("plan-work:success")?.displayLabel).toBe("Success");
    expect(byId.get("plan-work:success")?.edgeRole).toBe("success");
    expect(byId.get("review:rework")?.displayLabel).toBe("Rework");
    expect(byId.get("review:rework")?.edgeRole).toBe("rework");
    expect(byId.get("review:takeover")?.displayLabel).toBe("Takeover");
    expect(byId.get("review:takeover")?.edgeRole).toBe("takeover");
    expect(byId.get("plan-work:custom_exit")?.displayLabel).toBe("Custom exit");
    expect(byId.get("plan-work:custom_exit")?.edgeRole).toBe("other");
  });

  it("keeps terminal done transitions omitted from topology edges", () => {
    const topo = buildGraphTopology(compileManifest(visualGraph));

    expect(topo.edges.some((e) => e.target === "done")).toBe(false);
    expect(topo.edges.some((e) => e.outcome === "approve")).toBe(false);
  });
});
