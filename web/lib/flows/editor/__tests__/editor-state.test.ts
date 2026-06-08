import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { flowYamlV1Schema } from "@/lib/config.schema";
import { MaisterError } from "@/lib/errors";
import {
  addGate,
  addNode,
  moveNode,
  removeGate,
  removeNode,
  replaceNode,
  setNodeAction,
  setNodeSettings,
  setTransition,
} from "@/lib/flows/editor/editor-state";
import { readPresentation } from "@/lib/flows/editor/manifest-io";
import { validateNodeDraft } from "@/lib/flows/editor/node-form";

// ─── Fixture ─────────────────────────────────────────────────────────────────

// Two-node graph: plan (ai_coding) -> review (human).
// plan has a transition "approve" -> "review" and a presentation entry.
const BASE_MANIFEST: FlowYamlV1 = flowYamlV1Schema.parse({
  schemaVersion: 1,
  name: "Test Flow",
  nodes: [
    {
      id: "plan",
      type: "ai_coding",
      action: { prompt: "do the plan" },
      transitions: { approve: "review" },
      rework: {
        allowedTargets: ["plan"],
        workspacePolicies: ["keep"],
        maxLoops: 3,
      },
      pre_finish: {
        gates: [{ id: "g1", kind: "command_check" }],
      },
    },
    {
      id: "review",
      type: "human",
      transitions: { approve: "done" },
    },
  ],
  presentation: {
    nodes: [
      { id: "plan", x: 0, y: 0 },
      { id: "review", x: 200, y: 0 },
    ],
  },
});

// Helper: deep snapshot of the input so we can verify it is unchanged.
function snapshot(m: FlowYamlV1): string {
  return JSON.stringify(m);
}

// ─── addNode ─────────────────────────────────────────────────────────────────

describe("addNode", () => {
  it("adds a new node and returns a new manifest", () => {
    const before = snapshot(BASE_MANIFEST);
    const result = addNode(BASE_MANIFEST, "cli", "build");

    expect(snapshot(BASE_MANIFEST)).toBe(before);
    expect(result).not.toBe(BASE_MANIFEST);
    expect(result.nodes?.length).toBe(3);

    const added = result.nodes?.find((n) => n.id === "build");

    expect(added).toBeDefined();
    expect(added?.type).toBe("cli");
  });

  it("added node passes validateNodeDraft", () => {
    const result = addNode(BASE_MANIFEST, "ai_coding", "code-step");
    const added = result.nodes?.find((n) => n.id === "code-step");

    expect(validateNodeDraft(added)).toEqual({ ok: true });
  });

  it("throws CONFIG MaisterError on duplicate id", () => {
    expect(() => addNode(BASE_MANIFEST, "cli", "plan")).toThrow(MaisterError);

    try {
      addNode(BASE_MANIFEST, "cli", "plan");
    } catch (err) {
      expect(err instanceof MaisterError).toBe(true);
      expect((err as MaisterError).code).toBe("CONFIG");
    }
  });

  it("original manifest is unchanged after dup-id throw", () => {
    const before = snapshot(BASE_MANIFEST);

    try {
      addNode(BASE_MANIFEST, "cli", "plan");
    } catch {
      // expected
    }

    expect(snapshot(BASE_MANIFEST)).toBe(before);
  });

  it("all node types can be added", () => {
    const types = ["ai_coding", "cli", "check", "judge", "human"] as const;

    for (const type of types) {
      const result = addNode(BASE_MANIFEST, type, `new-${type}`);
      const added = result.nodes?.find((n) => n.id === `new-${type}`);

      expect(added?.type, `type ${type}`).toBe(type);
      expect(validateNodeDraft(added), `type ${type}`).toEqual({ ok: true });
    }
  });
});

// ─── removeNode ──────────────────────────────────────────────────────────────

describe("removeNode", () => {
  it("removes the node from nodes[]", () => {
    const before = snapshot(BASE_MANIFEST);
    const result = removeNode(BASE_MANIFEST, "review");

    expect(snapshot(BASE_MANIFEST)).toBe(before);
    expect(result).not.toBe(BASE_MANIFEST);
    expect(result.nodes?.find((n) => n.id === "review")).toBeUndefined();
  });

  it("scrubs transitions pointing at the removed node", () => {
    // plan.transitions.approve -> "review"; removing "review" should delete that outcome
    const result = removeNode(BASE_MANIFEST, "review");
    const plan = result.nodes?.find((n) => n.id === "plan");

    expect(plan?.transitions?.["approve"]).toBeUndefined();
  });

  it("preserves transitions pointing elsewhere (done, or other nodes)", () => {
    // review.transitions.approve -> "done"; removing "plan" should leave "review" intact
    const result = removeNode(BASE_MANIFEST, "plan");
    const review = result.nodes?.find((n) => n.id === "review");

    expect(review?.transitions?.["approve"]).toBe("done");
  });

  it("drops the presentation entry for the removed node", () => {
    const result = removeNode(BASE_MANIFEST, "plan");
    const pres = readPresentation(result);

    expect(pres.find((p) => p.id === "plan")).toBeUndefined();
    expect(pres.find((p) => p.id === "review")).toBeDefined();
  });

  it("drops the removed node id from every rework.allowedTargets", () => {
    // plan.rework.allowedTargets = ["plan"]; removing "plan" should clean it
    // First add a node that has plan in its allowedTargets
    let m = addNode(BASE_MANIFEST, "ai_coding", "step2");

    m = flowYamlV1Schema.parse({
      ...m,
      nodes: m.nodes?.map((n) =>
        n.id === "step2"
          ? {
              ...n,
              rework: {
                allowedTargets: ["plan", "step2"],
                workspacePolicies: ["keep"],
                maxLoops: 2,
              },
            }
          : n,
      ),
    });

    const result = removeNode(m, "plan");
    const step2 = result.nodes?.find((n) => n.id === "step2");

    expect(step2?.rework?.allowedTargets).not.toContain("plan");
    expect(step2?.rework?.allowedTargets).toContain("step2");
  });

  it("is a no-op if node id is absent", () => {
    const before = snapshot(BASE_MANIFEST);
    const result = removeNode(BASE_MANIFEST, "nonexistent");

    // Returns new object but nodes/presentation unchanged
    expect(snapshot(result)).toBe(before);
  });

  it("returns a new object even for no-op", () => {
    const result = removeNode(BASE_MANIFEST, "nonexistent");

    expect(result).not.toBe(BASE_MANIFEST);
  });
});

// ─── setTransition ───────────────────────────────────────────────────────────

describe("setTransition", () => {
  it("sets a new outcome on the source node", () => {
    const before = snapshot(BASE_MANIFEST);
    const result = setTransition(BASE_MANIFEST, "review", "reject", "plan");

    expect(snapshot(BASE_MANIFEST)).toBe(before);
    expect(
      result.nodes?.find((n) => n.id === "review")?.transitions?.["reject"],
    ).toBe("plan");
  });

  it("overwrites an existing outcome", () => {
    const result = setTransition(BASE_MANIFEST, "plan", "approve", "done");

    expect(
      result.nodes?.find((n) => n.id === "plan")?.transitions?.["approve"],
    ).toBe("done");
  });

  it("deletes an outcome when target is null", () => {
    const result = setTransition(BASE_MANIFEST, "plan", "approve", null);
    const plan = result.nodes?.find((n) => n.id === "plan");

    expect(plan?.transitions?.["approve"]).toBeUndefined();
    expect(Object.keys(plan?.transitions ?? {})).not.toContain("approve");
  });

  it("sets outcome to 'done' (terminal target)", () => {
    const result = setTransition(BASE_MANIFEST, "plan", "finish", "done");

    expect(
      result.nodes?.find((n) => n.id === "plan")?.transitions?.["finish"],
    ).toBe("done");
  });

  it("returns a new object", () => {
    const result = setTransition(BASE_MANIFEST, "plan", "approve", "done");

    expect(result).not.toBe(BASE_MANIFEST);
  });

  it("input manifest unchanged", () => {
    const before = snapshot(BASE_MANIFEST);

    setTransition(BASE_MANIFEST, "plan", "approve", "done");
    expect(snapshot(BASE_MANIFEST)).toBe(before);
  });
});

// ─── setNodeSettings ─────────────────────────────────────────────────────────

describe("setNodeSettings", () => {
  it("replaces the settings on the target node", () => {
    const before = snapshot(BASE_MANIFEST);
    const newSettings = { model: "claude-opus-4-5", thinkingEffort: "high" };
    const result = setNodeSettings(BASE_MANIFEST, "plan", newSettings);

    expect(snapshot(BASE_MANIFEST)).toBe(before);

    const plan = result.nodes?.find((n) => n.id === "plan");

    // Cast because settings is a union type
    const settings = plan?.settings as Record<string, unknown> | undefined;

    expect(settings?.["model"]).toBe("claude-opus-4-5");
    expect(settings?.["thinkingEffort"]).toBe("high");
  });

  it("returns a new object", () => {
    const result = setNodeSettings(BASE_MANIFEST, "plan", { model: "x" });

    expect(result).not.toBe(BASE_MANIFEST);
  });

  it("other nodes are not mutated", () => {
    const result = setNodeSettings(BASE_MANIFEST, "plan", { model: "x" });
    const review = result.nodes?.find((n) => n.id === "review");
    const origReview = BASE_MANIFEST.nodes?.find((n) => n.id === "review");

    expect(review).toEqual(origReview);
  });

  it("sets settings to undefined-equivalent (null) on a node", () => {
    // Setting with an empty object is valid (optional fields)
    const result = setNodeSettings(BASE_MANIFEST, "plan", {});

    expect(result.nodes?.find((n) => n.id === "plan")?.settings).toEqual({});
  });
});

// ─── setNodeAction ────────────────────────────────────────────────────────────

describe("setNodeAction", () => {
  it("replaces the action on the target node", () => {
    const before = snapshot(BASE_MANIFEST);
    const result = setNodeAction(BASE_MANIFEST, "plan", {
      prompt: "new prompt",
    });

    expect(snapshot(BASE_MANIFEST)).toBe(before);

    const plan = result.nodes?.find((n) => n.id === "plan");
    const action = plan?.action as Record<string, unknown> | undefined;

    expect(action?.["prompt"]).toBe("new prompt");
  });

  it("returns a new object", () => {
    const result = setNodeAction(BASE_MANIFEST, "plan", { prompt: "x" });

    expect(result).not.toBe(BASE_MANIFEST);
  });

  it("other nodes are not touched", () => {
    const result = setNodeAction(BASE_MANIFEST, "plan", { prompt: "x" });
    const review = result.nodes?.find((n) => n.id === "review");
    const origReview = BASE_MANIFEST.nodes?.find((n) => n.id === "review");

    expect(review).toEqual(origReview);
  });

  it("input unchanged after setNodeAction", () => {
    const before = snapshot(BASE_MANIFEST);

    setNodeAction(BASE_MANIFEST, "plan", { prompt: "x" });
    expect(snapshot(BASE_MANIFEST)).toBe(before);
  });
});

// ─── addGate ─────────────────────────────────────────────────────────────────

describe("addGate", () => {
  it("adds a new gate to the node's pre_finish.gates", () => {
    const before = snapshot(BASE_MANIFEST);
    const result = addGate(BASE_MANIFEST, "plan", "skill_check", "g-new");

    expect(snapshot(BASE_MANIFEST)).toBe(before);

    const gates = result.nodes?.find((n) => n.id === "plan")?.pre_finish?.gates;

    expect(gates?.find((g) => g.id === "g-new")).toBeDefined();
    expect(gates?.find((g) => g.id === "g-new")?.kind).toBe("skill_check");
  });

  it("throws CONFIG MaisterError on duplicate gateId within same node", () => {
    expect(() => addGate(BASE_MANIFEST, "plan", "skill_check", "g1")).toThrow(
      MaisterError,
    );

    try {
      addGate(BASE_MANIFEST, "plan", "skill_check", "g1");
    } catch (err) {
      expect((err as MaisterError).code).toBe("CONFIG");
    }
  });

  it("allows same gateId on a different node (no cross-node collision)", () => {
    // "review" has no gates; adding "g1" to it should be fine
    expect(() =>
      addGate(BASE_MANIFEST, "review", "command_check", "g1"),
    ).not.toThrow();
  });

  it("adds to a node that has no pre_finish block yet", () => {
    const result = addGate(BASE_MANIFEST, "review", "ai_judgment", "gR");
    const gates = result.nodes?.find((n) => n.id === "review")?.pre_finish
      ?.gates;

    expect(gates?.length).toBe(1);
    expect(gates?.[0]?.id).toBe("gR");
  });

  it("returns a new object", () => {
    const result = addGate(BASE_MANIFEST, "review", "command_check", "g-x");

    expect(result).not.toBe(BASE_MANIFEST);
  });

  it("input unchanged after addGate", () => {
    const before = snapshot(BASE_MANIFEST);

    addGate(BASE_MANIFEST, "review", "command_check", "g-x");
    expect(snapshot(BASE_MANIFEST)).toBe(before);
  });
});

// ─── removeGate ──────────────────────────────────────────────────────────────

describe("removeGate", () => {
  it("removes the gate from the node's pre_finish.gates", () => {
    const before = snapshot(BASE_MANIFEST);
    const result = removeGate(BASE_MANIFEST, "plan", "g1");

    expect(snapshot(BASE_MANIFEST)).toBe(before);

    const gates = result.nodes?.find((n) => n.id === "plan")?.pre_finish?.gates;

    expect(gates?.find((g) => g.id === "g1")).toBeUndefined();
  });

  it("is a no-op if gate does not exist", () => {
    const before = snapshot(BASE_MANIFEST);
    const result = removeGate(BASE_MANIFEST, "plan", "nonexistent-gate");

    // Gates should be the same
    const planBefore = BASE_MANIFEST.nodes?.find((n) => n.id === "plan");
    const planAfter = result.nodes?.find((n) => n.id === "plan");

    expect(planAfter?.pre_finish?.gates?.length).toBe(
      planBefore?.pre_finish?.gates?.length,
    );
    expect(snapshot(BASE_MANIFEST)).toBe(before);
  });

  it("returns a new object", () => {
    const result = removeGate(BASE_MANIFEST, "plan", "g1");

    expect(result).not.toBe(BASE_MANIFEST);
  });

  it("input unchanged after removeGate", () => {
    const before = snapshot(BASE_MANIFEST);

    removeGate(BASE_MANIFEST, "plan", "g1");
    expect(snapshot(BASE_MANIFEST)).toBe(before);
  });
});

// ─── moveNode ────────────────────────────────────────────────────────────────

describe("moveNode", () => {
  it("updates the presentation entry for the given node", () => {
    const before = snapshot(BASE_MANIFEST);
    const result = moveNode(BASE_MANIFEST, "plan", { x: 100, y: 200 });

    expect(snapshot(BASE_MANIFEST)).toBe(before);

    const pres = readPresentation(result);
    const planPres = pres.find((p) => p.id === "plan");

    expect(planPres?.x).toBe(100);
    expect(planPres?.y).toBe(200);
  });

  it("round-trips via readPresentation", () => {
    const result = moveNode(BASE_MANIFEST, "review", {
      x: 500,
      y: 300,
      width: 220,
      height: 90,
      color: "green",
    });
    const pres = readPresentation(result);
    const reviewPres = pres.find((p) => p.id === "review");

    expect(reviewPres).toEqual({
      id: "review",
      x: 500,
      y: 300,
      width: 220,
      height: 90,
      color: "green",
    });
  });

  it("merges with existing presentation (preserves color if not passed)", () => {
    // plan starts with x:0, y:0; move only updates x and y
    const result = moveNode(BASE_MANIFEST, "plan", { x: 50, y: 60 });
    const pres = readPresentation(result);
    const planPres = pres.find((p) => p.id === "plan");

    expect(planPres?.x).toBe(50);
    expect(planPres?.y).toBe(60);
  });

  it("other presentation entries are preserved", () => {
    const result = moveNode(BASE_MANIFEST, "plan", { x: 999, y: 999 });
    const pres = readPresentation(result);

    expect(pres.find((p) => p.id === "review")).toBeDefined();
  });

  it("can set width/height/color", () => {
    const result = moveNode(BASE_MANIFEST, "plan", {
      x: 0,
      y: 0,
      width: 300,
      height: 100,
      color: "blue",
    });
    const pres = readPresentation(result);
    const planPres = pres.find((p) => p.id === "plan");

    expect(planPres?.width).toBe(300);
    expect(planPres?.height).toBe(100);
    expect(planPres?.color).toBe("blue");
  });

  it("returns a new object", () => {
    const result = moveNode(BASE_MANIFEST, "plan", { x: 1, y: 2 });

    expect(result).not.toBe(BASE_MANIFEST);
  });

  it("input unchanged after moveNode", () => {
    const before = snapshot(BASE_MANIFEST);

    moveNode(BASE_MANIFEST, "plan", { x: 999, y: 999 });
    expect(snapshot(BASE_MANIFEST)).toBe(before);
  });
});

// ─── replaceNode ─────────────────────────────────────────────────────────────

describe("replaceNode", () => {
  // Mirror how the side-form builds the next node: start from the existing
  // (typed) NodeDef and override edited fields, so the parsed-output type
  // (e.g. ai_coding settings' defaulted `runner_type`) stays intact.
  const basePlan = BASE_MANIFEST.nodes?.find(
    (n) => n.id === "plan",
  ) as NonNullable<FlowYamlV1["nodes"]>[number];
  const nextPlan = {
    ...basePlan,
    action: { prompt: "REPLACED prompt" },
  } as NonNullable<FlowYamlV1["nodes"]>[number];

  it("swaps the matching node wholesale and leaves siblings untouched", () => {
    const result = replaceNode(BASE_MANIFEST, "plan", nextPlan);
    const plan = result.nodes?.find((n) => n.id === "plan");
    const review = result.nodes?.find((n) => n.id === "review");

    expect(plan).toEqual(nextPlan);
    expect((plan as { action: { prompt: string } }).action.prompt).toBe(
      "REPLACED prompt",
    );
    expect(review).toEqual(BASE_MANIFEST.nodes?.find((n) => n.id === "review"));
  });

  it("produces a manifest that still parses", () => {
    const result = replaceNode(BASE_MANIFEST, "plan", nextPlan);

    expect(() => flowYamlV1Schema.parse(result)).not.toThrow();
  });

  it("is a no-op (new object, equal content) when the id is absent", () => {
    const result = replaceNode(BASE_MANIFEST, "nope", nextPlan);

    expect(result).not.toBe(BASE_MANIFEST);
    expect(snapshot(result)).toBe(snapshot(BASE_MANIFEST));
  });

  it("does not mutate the input", () => {
    const before = snapshot(BASE_MANIFEST);

    replaceNode(BASE_MANIFEST, "plan", nextPlan);
    expect(snapshot(BASE_MANIFEST)).toBe(before);
  });
});
