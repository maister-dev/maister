import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";
import type { RecipeSlotDeclaration } from "@/lib/evaluations/materialization";

import { describe, expect, it } from "vitest";

import {
  buildMaterializationSnapshot,
  resolveRecipeSlotBindings,
} from "@/lib/evaluations/materialization";
import { parseControlledRecipe } from "@/lib/evaluations/recipe";

function runner(
  overrides: Partial<RunnerCatalogEntry> = {},
): RunnerCatalogEntry {
  const base: RunnerCatalogEntry = {
    id: "runner-sonnet",
    adapter: "claude",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    providerKind: "anthropic",
    permissionPolicy: "default",
    enabled: true,
    ready: true,
  };

  return { ...base, ...overrides };
}

const catalog: RunnerCatalogEntry[] = [
  runner(),
  runner({ id: "runner-opus", model: "claude-opus-4-8" }),
  runner({
    id: "runner-codex",
    capabilityAgent: "codex",
    adapter: "codex",
    model: "gpt-5",
  }),
];

function decl(
  slotKey: string,
  required = true,
  capabilityAgent?: string,
): RecipeSlotDeclaration {
  return { slotKey, required, capabilityAgent };
}

const defaultChain = { platformDefaultRunnerId: "runner-sonnet" };

function recipeWithSlots(
  slotBindings: Record<string, unknown>,
): ReturnType<typeof parseControlledRecipe> {
  return parseControlledRecipe({
    schemaVersion: 1,
    flow: {
      flowRefId: "bugfix",
      flowRevisionId: "rev-1",
      inputContractDigest: "i",
      artifactContractDigest: "a",
    },
    inputs: { taskSnapshotRef: "snap", formValues: {} },
    executionPolicy: { preset: "supervised" },
    slotBindings,
  });
}

describe("resolveRecipeSlotBindings", () => {
  it("resolves a concrete runner-override slot (model honored)", () => {
    const recipe = recipeWithSlots({
      "session:main": { mode: "runner", runnerId: "runner-opus" },
    });
    const result = resolveRecipeSlotBindings({
      slotBindings: recipe.slotBindings,
      declaredSlots: [decl("session:main")],
      runners: catalog,
      defaultChain,
    });

    expect(result.refusals).toEqual([]);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].runnerId).toBe("runner-opus");
    expect(result.resolved[0].model).toBe("claude-opus-4-8");
    expect(result.resolved[0].resolutionSource).toBe("recipe_runner");
    expect(result.resolved[0].softMismatch).toBeUndefined();
  });

  it("resolves EVERY declared slot, not just the primary session", () => {
    const recipe = recipeWithSlots({
      "session:main": { mode: "runner", runnerId: "runner-sonnet" },
      "consensus:vote": { mode: "runner", runnerId: "runner-opus" },
    });
    const result = resolveRecipeSlotBindings({
      slotBindings: recipe.slotBindings,
      declaredSlots: [decl("session:main"), decl("consensus:vote")],
      runners: catalog,
      defaultChain,
    });

    expect(result.refusals).toEqual([]);
    expect(result.resolved.map((s) => s.slotKey).sort()).toEqual([
      "consensus:vote",
      "session:main",
    ]);
  });

  it("records a soft mismatch for a same-capability intent (never an unenforced model claim)", () => {
    const recipe = recipeWithSlots({
      "session:main": {
        mode: "intent",
        config: { capability_agent: "claude", model: "claude-haiku-4-5" },
      },
    });
    const result = resolveRecipeSlotBindings({
      slotBindings: recipe.slotBindings,
      declaredSlots: [decl("session:main")],
      runners: catalog,
      defaultChain,
    });

    expect(result.refusals).toEqual([]);
    const slot = result.resolved[0];

    expect(slot.resolutionSource).toBe("recipe_intent_soft");
    // The persisted model is the LAUNCHED model, never the requested one.
    expect(slot.model).not.toBe("claude-haiku-4-5");
    expect(slot.softMismatch?.requestedModel).toBe("claude-haiku-4-5");
    expect(slot.softMismatch?.launchedModel).toBe(slot.model);
  });

  it("resolves an exact intent with no soft mismatch", () => {
    const recipe = recipeWithSlots({
      "session:main": {
        mode: "intent",
        config: { capability_agent: "claude", model: "claude-opus-4-8" },
      },
    });
    const result = resolveRecipeSlotBindings({
      slotBindings: recipe.slotBindings,
      declaredSlots: [decl("session:main")],
      runners: catalog,
      defaultChain,
    });

    expect(result.resolved[0].resolutionSource).toBe("recipe_intent_exact");
    expect(result.resolved[0].softMismatch).toBeUndefined();
  });

  it("resolves an unbound optional slot via the default chain", () => {
    const result = resolveRecipeSlotBindings({
      slotBindings: {},
      declaredSlots: [decl("session:default", false)],
      runners: catalog,
      defaultChain,
    });

    expect(result.refusals).toEqual([]);
    expect(result.resolved[0].resolutionSource).toBe("default_chain");
    expect(result.resolved[0].runnerId).toBe("runner-sonnet");
  });

  it("refuses an unbound required slot", () => {
    const result = resolveRecipeSlotBindings({
      slotBindings: {},
      declaredSlots: [decl("consensus:vote", true)],
      runners: catalog,
      defaultChain,
    });

    expect(result.refusals.map((r) => r.code)).toContain("slot_unbound");
  });

  it("refuses a stale slot key the Flow no longer declares", () => {
    const recipe = recipeWithSlots({
      "session:main": { mode: "runner", runnerId: "runner-sonnet" },
      "session:ghost": { mode: "runner", runnerId: "runner-sonnet" },
    });
    const result = resolveRecipeSlotBindings({
      slotBindings: recipe.slotBindings,
      declaredSlots: [decl("session:main")],
      runners: catalog,
      defaultChain,
    });

    expect(result.refusals.map((r) => r.code)).toContain("slot_unknown");
  });

  it("refuses a runner-override whose capability does not match the slot", () => {
    const recipe = recipeWithSlots({
      "session:main": { mode: "runner", runnerId: "runner-codex" },
    });
    const result = resolveRecipeSlotBindings({
      slotBindings: recipe.slotBindings,
      declaredSlots: [decl("session:main", true, "claude")],
      runners: catalog,
      defaultChain,
    });

    expect(result.refusals.map((r) => r.code)).toContain(
      "slot_runner_capability_mismatch",
    );
  });

  it("refuses an intent with no same-capability host runner", () => {
    const recipe = recipeWithSlots({
      "session:main": {
        mode: "intent",
        config: { capability_agent: "gemini" },
      },
    });
    const result = resolveRecipeSlotBindings({
      slotBindings: recipe.slotBindings,
      declaredSlots: [decl("session:main")],
      runners: catalog,
      defaultChain,
    });

    expect(result.refusals.map((r) => r.code)).toContain(
      "slot_intent_unsatisfiable",
    );
  });

  it("refuses a pinned runner that is disabled", () => {
    const result = resolveRecipeSlotBindings({
      slotBindings: recipeWithSlots({
        "session:main": { mode: "runner", runnerId: "runner-off" },
      }).slotBindings,
      declaredSlots: [decl("session:main")],
      runners: [...catalog, runner({ id: "runner-off", enabled: false })],
      defaultChain,
    });

    expect(result.refusals.map((r) => r.code)).toContain(
      "slot_runner_unavailable",
    );
  });
});

describe("buildMaterializationSnapshot", () => {
  it("produces deterministic digests independent of slot order", () => {
    const recipe = recipeWithSlots({
      "session:main": { mode: "runner", runnerId: "runner-sonnet" },
    });
    const a = resolveRecipeSlotBindings({
      slotBindings: recipe.slotBindings,
      declaredSlots: [decl("session:main"), decl("consensus:vote", false)],
      runners: catalog,
      defaultChain,
    });
    const snapA = buildMaterializationSnapshot(recipe, a.resolved);
    const snapB = buildMaterializationSnapshot(
      recipe,
      [...a.resolved].reverse(),
    );

    expect(snapB.digests.materializationDigest).toBe(
      snapA.digests.materializationDigest,
    );
    expect(snapA.slots[0].slotKey <= snapA.slots[1].slotKey).toBe(true);
  });

  it("changes the materialization digest when a resolved runner changes", () => {
    const recipe = recipeWithSlots({
      "session:main": { mode: "runner", runnerId: "runner-sonnet" },
    });
    const withSonnet = resolveRecipeSlotBindings({
      slotBindings: recipe.slotBindings,
      declaredSlots: [decl("session:main")],
      runners: catalog,
      defaultChain,
    });
    const opusRecipe = recipeWithSlots({
      "session:main": { mode: "runner", runnerId: "runner-opus" },
    });
    const withOpus = resolveRecipeSlotBindings({
      slotBindings: opusRecipe.slotBindings,
      declaredSlots: [decl("session:main")],
      runners: catalog,
      defaultChain,
    });

    expect(
      buildMaterializationSnapshot(recipe, withSonnet.resolved).digests
        .materializationDigest,
    ).not.toBe(
      buildMaterializationSnapshot(opusRecipe, withOpus.resolved).digests
        .materializationDigest,
    );
  });
});
