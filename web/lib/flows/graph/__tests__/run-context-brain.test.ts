import { describe, expect, it } from "vitest";

import { buildRunContext } from "@/lib/flows/graph/run-context";

// T4.3 — buildRunContext stays PURE: it passes an already-recalled brain
// projection through as plain data and never recalls/embeds itself.
describe("buildRunContext brain passthrough (T4.3)", () => {
  it("includes the brain projection when provided", () => {
    const brain = [
      { kind: "lesson", title: "t", content: "c", confidence: 0.3, tags: ["a"] },
    ];
    const ctx = buildRunContext({
      taskPrompt: "the intent",
      nodeAttempts: [],
      gateResults: [],
      brain,
    });

    expect(ctx.brain).toEqual(brain);
    expect(ctx.intent).toBe("the intent");
  });

  it("omits the brain key entirely when no projection is provided", () => {
    const ctx = buildRunContext({
      taskPrompt: "p",
      nodeAttempts: [],
      gateResults: [],
    });

    expect(ctx.brain).toBeUndefined();
    expect("brain" in ctx).toBe(false);
  });
});
