import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";
import type {
  PreflightFlowRevision,
  PreflightInput,
  PreflightMethodRequirements,
  PreflightOverlayCatalog,
} from "@/lib/evaluations/preflight";

import { describe, expect, it } from "vitest";

import {
  computeArtifactContractDigest,
  computeInputContractDigest,
} from "@/lib/evaluations/recipe";
import { parseControlledRecipe } from "@/lib/evaluations/recipe";
import { preflightControlledRecipe } from "@/lib/evaluations/preflight";

function runner(
  overrides: Partial<RunnerCatalogEntry> = {},
): RunnerCatalogEntry {
  const base: RunnerCatalogEntry = {
    id: "runner-1",
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

function flowRevision(
  overrides: Partial<PreflightFlowRevision> = {},
): PreflightFlowRevision {
  const base: PreflightFlowRevision = {
    flowRefId: "bugfix",
    flowRevisionId: "rev-1",
    projectId: "project-1",
    trusted: true,
    enablementLaunchable: true,
    engineCompatible: true,
    schemaVersionSupported: true,
    requiredTaskFields: ["title"],
    formRequiredFields: ["title"],
    formKnownFields: ["title", "notes"],
    producedArtifactKinds: ["diff", "test_report"],
    slotKeys: ["session:main"],
    requiredSlotKeys: [],
    ...overrides,
  };

  return base;
}

function method(
  overrides: Partial<PreflightMethodRequirements> = {},
): PreflightMethodRequirements {
  return {
    qualifiedId: "core:sdd-quality",
    requiredArtifactKinds: ["diff"],
    ...overrides,
  };
}

function overlayCatalog(): PreflightOverlayCatalog {
  return {
    rules: new Set(["core:rule-a"]),
    skills: new Set(["core:skill-a"]),
    mcps: new Set(),
    subagents: new Set(),
  };
}

// Build a recipe whose frozen contract digests match the given flow revision, so
// the drift checks pass unless a test deliberately drifts the flow.
function recipeFor(
  flow: PreflightFlowRevision,
  overrides: Record<string, unknown> = {},
) {
  return parseControlledRecipe({
    schemaVersion: 1,
    flow: {
      flowRefId: flow.flowRefId,
      flowRevisionId: flow.flowRevisionId,
      inputContractDigest: computeInputContractDigest(flow),
      artifactContractDigest: computeArtifactContractDigest(flow),
    },
    inputs: { taskSnapshotRef: "snap-1", formValues: { title: "x" } },
    executionPolicy: { preset: "supervised" },
    slotBindings: { "session:main": { mode: "runner", runnerId: "runner-1" } },
    ...overrides,
  });
}

function input(over: Partial<PreflightInput> = {}): PreflightInput {
  const flow = over.flow ?? flowRevision();

  return {
    recipe: over.recipe ?? recipeFor(flow),
    study: over.study ?? { projectId: "project-1", taskId: "task-1" },
    flow,
    method: over.method ?? method(),
    runners: over.runners ?? [runner()],
    overlayCatalog: over.overlayCatalog ?? overlayCatalog(),
  };
}

describe("preflightControlledRecipe", () => {
  it("passes a fully compatible recipe with no refusals or warnings", () => {
    const result = preflightControlledRecipe(input());

    expect(result.ok).toBe(true);
    expect(result.refusals).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("refuses a cross-project flow revision (ownership)", () => {
    const flow = flowRevision({ projectId: "other-project" });
    const result = preflightControlledRecipe(
      input({ flow, recipe: recipeFor(flow) }),
    );

    expect(result.ok).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain("ownership_mismatch");
  });

  it("refuses an untrusted flow", () => {
    const flow = flowRevision({ trusted: false });
    const result = preflightControlledRecipe(
      input({ flow, recipe: recipeFor(flow) }),
    );

    expect(result.refusals.map((r) => r.code)).toContain("flow_untrusted");
  });

  it("refuses an engine-incompatible flow", () => {
    const flow = flowRevision({ engineCompatible: false });
    const result = preflightControlledRecipe(
      input({ flow, recipe: recipeFor(flow) }),
    );

    expect(result.refusals.map((r) => r.code)).toContain("engine_incompatible");
  });

  it("detects input-contract drift (stale package revision)", () => {
    const frozenFlow = flowRevision();
    const recipe = recipeFor(frozenFlow);
    // Live flow now requires an extra form field → the frozen input digest is stale.
    const liveFlow = flowRevision({
      formRequiredFields: ["title", "severity"],
      formKnownFields: ["title", "notes", "severity"],
    });
    const result = preflightControlledRecipe(input({ flow: liveFlow, recipe }));

    expect(result.refusals.map((r) => r.code)).toContain(
      "input_contract_drift",
    );
  });

  it("refuses an unknown supplied form field (exact compat, no coercion)", () => {
    const flow = flowRevision();
    const recipe = recipeFor(flow, {
      inputs: {
        taskSnapshotRef: "snap-1",
        formValues: { title: "x", ghost: 1 },
      },
    });
    const result = preflightControlledRecipe(input({ flow, recipe }));

    expect(result.refusals.map((r) => r.code)).toContain("form_field_unknown");
  });

  it("refuses a missing required form field", () => {
    const flow = flowRevision();
    const recipe = recipeFor(flow, {
      inputs: { taskSnapshotRef: "snap-1", formValues: { notes: "x" } },
    });
    const result = preflightControlledRecipe(input({ flow, recipe }));

    expect(result.refusals.map((r) => r.code)).toContain(
      "form_required_missing",
    );
  });

  it("refuses when the flow does not produce a method-required artifact", () => {
    const result = preflightControlledRecipe(
      input({ method: method({ requiredArtifactKinds: ["contract_report"] }) }),
    );

    expect(result.refusals.map((r) => r.code)).toContain(
      "artifact_requirement_uncovered",
    );
  });

  it("refuses a binding for a slot the flow does not declare", () => {
    const flow = flowRevision();
    const recipe = recipeFor(flow, {
      slotBindings: {
        "session:main": { mode: "runner", runnerId: "runner-1" },
        "session:ghost": { mode: "runner", runnerId: "runner-1" },
      },
    });
    const result = preflightControlledRecipe(input({ flow, recipe }));

    expect(result.refusals.map((r) => r.code)).toContain("slot_unknown");
  });

  it("refuses an unbound required slot", () => {
    const flow = flowRevision({
      slotKeys: ["session:main", "consensus:vote"],
      requiredSlotKeys: ["consensus:vote"],
    });
    const result = preflightControlledRecipe(
      input({ flow, recipe: recipeFor(flow) }),
    );

    expect(result.refusals.map((r) => r.code)).toContain("slot_unbound");
  });

  it("refuses a pinned runner that is not ready", () => {
    const result = preflightControlledRecipe(
      input({ runners: [runner({ ready: false })] }),
    );

    expect(result.refusals.map((r) => r.code)).toContain(
      "slot_runner_unavailable",
    );
  });

  it("warns (not refuses) on a same-capability-only intent soft mismatch", () => {
    const flow = flowRevision();
    const recipe = recipeFor(flow, {
      slotBindings: {
        "session:main": {
          mode: "intent",
          config: { capability_agent: "claude", model: "claude-opus-4-8" },
        },
      },
    });
    // Only a sonnet runner exists → same-capability but not exact model.
    const result = preflightControlledRecipe(
      input({ flow, recipe, runners: [runner()] }),
    );

    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain(
      "slot_intent_soft_mismatch",
    );
  });

  it("warns (never silently passes) on an exact-intent slot the seam cannot thread", () => {
    const flow = flowRevision();
    const recipe = recipeFor(flow, {
      slotBindings: {
        "session:main": {
          mode: "intent",
          config: { capability_agent: "claude", model: "claude-sonnet-4-6" },
        },
      },
    });
    // An EXACT host runner exists, but the launch seam threads only mode:"runner"
    // hard-pins — an intent slot falls back to launchRun's default chain, so
    // preflight must WARN rather than pass silently (ADR-150 F2 / hard-warn).
    const result = preflightControlledRecipe(
      input({ flow, recipe, runners: [runner()] }),
    );

    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain(
      "slot_intent_soft_mismatch",
    );
  });

  it("refuses an intent with no same-capability host runner", () => {
    const flow = flowRevision();
    const recipe = recipeFor(flow, {
      slotBindings: {
        "session:main": {
          mode: "intent",
          config: { capability_agent: "codex" },
        },
      },
    });
    const result = preflightControlledRecipe(
      input({ flow, recipe, runners: [runner()] }),
    );

    expect(result.refusals.map((r) => r.code)).toContain(
      "slot_intent_unsatisfiable",
    );
  });

  it("refuses an unknown capability overlay ref", () => {
    const flow = flowRevision();
    const recipe = recipeFor(flow, {
      capabilityOverlay: { skills: { add: ["core:ghost-skill"] } },
    });
    const result = preflightControlledRecipe(input({ flow, recipe }));

    expect(result.refusals.map((r) => r.code)).toContain("overlay_ref_unknown");
  });

  it("aggregates multiple refusals (not fail-fast)", () => {
    const flow = flowRevision({ trusted: false, engineCompatible: false });
    const result = preflightControlledRecipe(
      input({ flow, recipe: recipeFor(flow) }),
    );

    expect(result.refusals.length).toBeGreaterThanOrEqual(2);
  });
});
