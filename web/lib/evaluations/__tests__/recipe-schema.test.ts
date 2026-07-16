import { describe, expect, it } from "vitest";

import {
  EVALUATION_RECIPE_HOLD_SOURCE,
  evaluationRecipeDefinitionSchema,
} from "@/lib/evaluations/recipe-schema";
import { parseControlledRecipe } from "@/lib/evaluations/recipe";

// Minimal valid controlled recipe (M47 D16). Optional sections are omitted to
// exercise the `.default`s; digests are placeholders (preflight recomputes them).
function validRecipe(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    flow: {
      flowRefId: "bugfix",
      flowRevisionId: "rev-1",
      inputContractDigest: "input-digest",
      artifactContractDigest: "artifact-digest",
    },
    inputs: {
      taskSnapshotRef: "task-snapshot-1",
      formValues: { title: "Fix the bug" },
    },
    executionPolicy: { preset: "supervised" },
    slotBindings: {
      "session:main": { mode: "runner", runnerId: "runner-1" },
    },
  };
}

describe("evaluationRecipeDefinitionSchema", () => {
  it("accepts a minimal valid recipe and fills defaults", () => {
    const parsed = parseControlledRecipe(validRecipe());

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.nodeAgentBindings).toEqual([]);
    expect(parsed.materializationIntent.packagePins).toEqual([]);
    // The forced promotion hold is defaulted when absent (D15).
    expect(parsed.promotionHold.source).toBe(EVALUATION_RECIPE_HOLD_SOURCE);
  });

  it("forces the promotion hold source to evaluation_study", () => {
    const raw = validRecipe();

    raw.promotionHold = { source: "user" };
    expect(() => parseControlledRecipe(raw)).toThrow(/invalid controlled/i);
  });

  it("rejects an arbitrary transform/mapping script (M47 non-goal)", () => {
    const raw = validRecipe();

    (raw.inputs as Record<string, unknown>).transform = "return x * 2";
    // `.strict()` on inputs rejects the unknown key.
    const result = evaluationRecipeDefinitionSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level key", () => {
    const raw = validRecipe();

    (raw as Record<string, unknown>).arbitrary = true;
    expect(evaluationRecipeDefinitionSchema.safeParse(raw).success).toBe(false);
  });

  it("accepts a typed runner-intent slot target", () => {
    const raw = validRecipe();

    raw.slotBindings = {
      "session:main": {
        mode: "intent",
        config: { capability_agent: "claude", model: "claude-sonnet-4-6" },
      },
    };
    const parsed = parseControlledRecipe(raw);
    const target = parsed.slotBindings["session:main"];

    expect(target.mode).toBe("intent");
  });

  it("rejects a slot target with an unknown mode", () => {
    const raw = validRecipe();

    raw.slotBindings = { "session:main": { mode: "magic", runnerId: "r1" } };
    expect(evaluationRecipeDefinitionSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects a non-positive replicate count", () => {
    const raw = validRecipe();

    raw.replicatePolicy = { groupKey: "g1", count: 0 };
    expect(evaluationRecipeDefinitionSchema.safeParse(raw).success).toBe(false);
  });

  it("throws a CONFIG MaisterError from parseControlledRecipe on invalid input", () => {
    expect(() => parseControlledRecipe({ schemaVersion: 2 })).toThrow(
      /invalid controlled evaluation recipe/i,
    );
  });
});
