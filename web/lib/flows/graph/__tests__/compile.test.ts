import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { compileManifest, resolveTransition } from "@/lib/flows/graph/compile";

const linear: FlowYamlV1 = {
  schemaVersion: 1,
  name: "greet",
  steps: [
    { id: "hello", type: "cli", command: "echo hi" },
    { id: "plan", type: "agent", mode: "new-session", prompt: "/aif-plan" },
    { id: "review", type: "human", form_schema: "./r.json" },
  ],
} as FlowYamlV1;

const graph: FlowYamlV1 = {
  schemaVersion: 1,
  name: "aif",
  compat: { engine_min: "1.1.0" },
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
      pre_finish: {
        gates: [
          { id: "g", kind: "command_check", mode: "blocking", command: "true" },
        ],
      },
      rework: {
        allowedTargets: ["implement"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
        commentsVar: "c",
      },
    },
  ],
} as FlowYamlV1;

describe("compileManifest — linear steps[]", () => {
  it("compiles each step to a single-action node chained by success -> next -> done", () => {
    const g = compileManifest(linear);

    expect(g.entry).toBe("hello");
    expect(g.order).toEqual(["hello", "plan", "review"]);

    const hello = g.nodes.get("hello")!;

    expect(hello.nodeType).toBe("cli");
    expect(hello.source.kind).toBe("step");
    expect(hello.transitions).toEqual({ success: "plan" });

    expect(g.nodes.get("plan")!.nodeType).toBe("ai_coding");
    expect(g.nodes.get("plan")!.transitions).toEqual({ success: "review" });

    const review = g.nodes.get("review")!;

    expect(review.nodeType).toBe("human");
    expect(review.transitions).toEqual({ success: "done" });
    expect(review.rework).toBeUndefined();
    expect(review.gates).toEqual([]);
  });

  it("resolveTransition returns null at the terminal step", () => {
    const g = compileManifest(linear);

    expect(resolveTransition(g.nodes.get("hello")!, "success")).toBe("plan");
    expect(resolveTransition(g.nodes.get("review")!, "success")).toBeNull();
  });
});

describe("compileManifest — graph nodes[]", () => {
  it("passes nodes through with transitions, gates, rework, finishHuman", () => {
    const g = compileManifest(graph);

    expect(g.entry).toBe("implement");

    const review = g.nodes.get("review")!;

    expect(review.source.kind).toBe("node");
    expect(review.transitions).toEqual({
      approve: "done",
      rework: "implement",
    });
    expect(review.gates).toHaveLength(1);
    expect(review.rework?.maxLoops).toBe(3);
    expect(review.finishHuman?.decisions).toEqual(["approve", "rework"]);
  });

  it("resolveTransition resolves a decision and treats 'done' as terminal", () => {
    const g = compileManifest(graph);
    const review = g.nodes.get("review")!;

    expect(resolveTransition(review, "approve")).toBeNull(); // -> "done"
    expect(resolveTransition(review, "rework")).toBe("implement");
    expect(resolveTransition(review, "unknown-decision")).toBeNull();
  });
});
