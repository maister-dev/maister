import { describe, expect, it } from "vitest";

import { computeEffectiveDelegationBounds } from "@/lib/orchestrator/bounds";

// ADR-165 AC-25 / spec C-10. `computeEffectiveDelegationBounds` is a PURE
// function: it turns (instance ceilings, node declaration, engine floor) into
// the bounds snapshotted on `runs.delegation_bounds`. The floor is the whole
// safety argument — below 3.7.0 the result must be byte-identical to today's
// env-only behaviour, so no shipped manifest changes meaning.

const INSTANCE = {
  maxDepth: 3,
  maxFanout: 16,
  flowPool: 6,
  agentPool: 3,
} as const;

const NODE = { nodeId: "orchestrate", nodeAttemptId: "na-1" } as const;

const BUDGET = {
  maxTokens: 2_000_000,
  wallClockMinutes: 120,
  maxChildRuns: 12,
  consecutiveFailures: 3,
} as const;

describe("computeEffectiveDelegationBounds (ADR-165 D5)", () => {
  describe("below the 3.7.0 floor → env-only, byte-identical to today", () => {
    it.each([null, "", "1.6.0", "3.0.0", "3.6.0", "3.6.9"])(
      "engineMin %s ignores every node declaration",
      (engineMin) => {
        const bounds = computeEffectiveDelegationBounds({
          instance: INSTANCE,
          engineMin,
          declared: {
            max_depth: 1,
            max_fanout: 2,
            max_active_children: 1,
            budget: BUDGET,
          },
          ...NODE,
        });

        expect(bounds.source).toBe("env");
        expect(bounds.maxDepth).toBe(INSTANCE.maxDepth);
        expect(bounds.maxFanout).toBe(INSTANCE.maxFanout);
        expect(bounds.maxActiveChildren).toBeNull();
        expect(bounds.budget).toBeNull();
      },
    );
  });

  describe("at or above the floor → min(instance, declared)", () => {
    it("undeclared falls back to the node defaults 2 / 6 / 3, capped by the instance", () => {
      const bounds = computeEffectiveDelegationBounds({
        instance: INSTANCE,
        engineMin: "3.7.0",
        declared: null,
        ...NODE,
      });

      expect(bounds.source).toBe("node");
      expect(bounds.maxDepth).toBe(2);
      expect(bounds.maxFanout).toBe(6);
      expect(bounds.maxActiveChildren).toBe(3);
      expect(bounds.budget).toBeNull();
    });

    it("a declaration ABOVE the instance ceiling yields the ceiling", () => {
      const bounds = computeEffectiveDelegationBounds({
        instance: INSTANCE,
        engineMin: "3.7.0",
        declared: {
          max_depth: 99,
          max_fanout: 99,
          max_active_children: 99,
          budget: BUDGET,
        },
        ...NODE,
      });

      expect(bounds.maxDepth).toBe(INSTANCE.maxDepth);
      expect(bounds.maxFanout).toBe(INSTANCE.maxFanout);
      // The active cap is bounded by the pool, not by the fan-out ceiling.
      expect(bounds.maxActiveChildren).toBe(INSTANCE.flowPool);
    });

    it("a declaration BELOW the instance ceiling yields the declaration", () => {
      const bounds = computeEffectiveDelegationBounds({
        instance: INSTANCE,
        engineMin: "3.7.0",
        declared: {
          max_depth: 1,
          max_fanout: 4,
          max_active_children: 2,
          budget: BUDGET,
        },
        ...NODE,
      });

      expect(bounds.maxDepth).toBe(1);
      expect(bounds.maxFanout).toBe(4);
      expect(bounds.maxActiveChildren).toBe(2);
    });

    it("copies the budget verbatim", () => {
      const bounds = computeEffectiveDelegationBounds({
        instance: INSTANCE,
        engineMin: "3.7.0",
        declared: { budget: BUDGET },
        ...NODE,
      });

      expect(bounds.budget).toEqual(BUDGET);
    });

    it.each(["3.7.0", "3.7.1", "3.8.0", "4.0.0"])(
      "engineMin %s is at or above the floor",
      (engineMin) => {
        expect(
          computeEffectiveDelegationBounds({
            instance: INSTANCE,
            engineMin,
            declared: null,
            ...NODE,
          }).source,
        ).toBe("node");
      },
    );
  });

  it("records the node attempt it was computed for, and the inputs it used", () => {
    const bounds = computeEffectiveDelegationBounds({
      instance: INSTANCE,
      engineMin: "3.7.0",
      declared: { max_fanout: 4, budget: BUDGET },
      ...NODE,
    });

    expect(bounds.nodeId).toBe("orchestrate");
    expect(bounds.nodeAttemptId).toBe("na-1");
    expect(bounds.engineMin).toBe("3.7.0");
    expect(bounds.declared).toEqual({ max_fanout: 4, budget: BUDGET });
    expect(bounds.instance).toEqual(INSTANCE);
  });
});
