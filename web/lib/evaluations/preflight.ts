// Controlled Evaluation Recipe input-contract preflight (M47, ADR-146 D16). This
// is the PURE decision core: given a parsed recipe and the resolved live
// contracts (Flow revision projection, selected Method evidence requirements,
// runner catalog, capability-ref catalog), it returns every typed refusal and
// warning WITHOUT any side effect. The preflight route assembles the live
// contracts and calls this; a launch service calls the same core before the
// first worktree side effect so an incompatible recipe never forks a branch.
//
// M47's first scope allows EXACT compatible contracts only (D16): no arbitrary
// form mapping, no cross-task datasets, no silent schema coercion. Each check
// below is exact/superset, never a lossy coercion.

import type { RunnerCatalogEntry } from "@/lib/acp-runners/resolve";
import type { EvaluationControlledRecipeDefinition } from "@/lib/evaluations/recipe-schema";
import type { FlowContractProjection } from "@/lib/evaluations/recipe";

import { runnerIntentCandidates } from "@/lib/acp-runners/resolve";
import {
  computeArtifactContractDigest,
  computeInputContractDigest,
} from "@/lib/evaluations/recipe";
import { isSeamThreadableSlot } from "@/lib/evaluations/slot-threading";

// The Flow revision resolved live at preflight time, with the launchability and
// trust facets M47 gates on. The projection reuses the FlowContractProjection
// (digest inputs) plus the launch-gate flags.
export interface PreflightFlowRevision extends FlowContractProjection {
  flowRefId: string;
  flowRevisionId: string;
  // The project the Flow revision belongs to (ownership check).
  projectId: string;
  // Launch-gate facets (mirrors the standard 10-step launch chain, D16).
  trusted: boolean;
  enablementLaunchable: boolean;
  engineCompatible: boolean;
  schemaVersionSupported: boolean;
  // Slot keys the Flow REQUIRES a binding for (a subset of `slotKeys`); an
  // unbound required slot that has no default-chain resolution is a refusal.
  requiredSlotKeys: string[];
  // The manifest `runner_profiles` map (for intent-ref slot resolution).
  runnerProfiles?: Record<string, unknown>;
}

// The selected Method's evidence/artifact requirements the Flow must cover.
export interface PreflightMethodRequirements {
  qualifiedId: string;
  // Coverage classes / artifact kinds the method's evidence protocol requires.
  requiredArtifactKinds: string[];
}

export interface PreflightStudyContext {
  projectId: string;
  taskId: string;
}

// Known capability refs per class (add/remove overlay validation, D16 "no strict
// capability silently degrades").
export interface PreflightOverlayCatalog {
  rules: ReadonlySet<string>;
  skills: ReadonlySet<string>;
  mcps: ReadonlySet<string>;
  subagents: ReadonlySet<string>;
}

export const PREFLIGHT_REFUSAL_CODES = [
  "ownership_mismatch",
  "flow_untrusted",
  "flow_not_launchable",
  "engine_incompatible",
  "schema_version_unsupported",
  "input_contract_drift",
  "artifact_contract_drift",
  "form_field_unknown",
  "form_required_missing",
  "artifact_requirement_uncovered",
  "slot_unknown",
  "slot_unbound",
  "slot_runner_unavailable",
  "slot_intent_unsatisfiable",
  "overlay_ref_unknown",
] as const;
export type PreflightRefusalCode = (typeof PREFLIGHT_REFUSAL_CODES)[number];

export interface PreflightRefusal {
  code: PreflightRefusalCode;
  message: string;
}

export interface PreflightWarning {
  code:
    | "slot_intent_soft_mismatch"
    | "slot_runner_pin_not_threaded"
    | "recipe_axis_not_threaded";
  // Slot-scoped warnings name their slot; axis warnings name the recipe axis.
  slotKey?: string;
  axis?: "capabilityOverlay" | "packagePins" | "nodeAgentBindings" | "budgets";
  message: string;
}

export interface PreflightResult {
  ok: boolean;
  refusals: PreflightRefusal[];
  warnings: PreflightWarning[];
}

export interface PreflightInput {
  recipe: EvaluationControlledRecipeDefinition;
  study: PreflightStudyContext;
  flow: PreflightFlowRevision;
  method: PreflightMethodRequirements;
  runners: readonly RunnerCatalogEntry[];
  overlayCatalog: PreflightOverlayCatalog;
}

function overlayClassRefs(
  catalog: PreflightOverlayCatalog,
  cls: "rules" | "skills" | "mcps" | "subagents",
): ReadonlySet<string> {
  return catalog[cls];
}

// Resolve a recipe slot target against the live runner catalog + manifest runner
// profiles. Returns null (satisfiable, no warning), a warning (soft mismatch), or
// a refusal (unsatisfiable). Kept internal — the exported preflight aggregates.
function checkSlotTarget(
  slotKey: string,
  target: EvaluationControlledRecipeDefinition["slotBindings"][string],
  runners: readonly RunnerCatalogEntry[],
): { refusal?: PreflightRefusal; warning?: PreflightWarning } {
  if (target.mode === "runner") {
    const runner = runners.find((r) => r.id === target.runnerId);

    if (!runner || !runner.enabled || !runner.ready) {
      return {
        refusal: {
          code: "slot_runner_unavailable",
          message: `slot "${slotKey}" pins runner "${target.runnerId}" which is missing, disabled, or not ready`,
        },
      };
    }

    // The launch seam threads a runner hard-pin ONLY for `session:` slots
    // (isSeamThreadableSlot). A pin on any other slot family — `consensus:`
    // participants above all — is silently dropped and the run falls back to the
    // default runner chain. WARN (never a silent pass, mirroring the intent-slot
    // warning) so a model-comparison author sees the pin will not be honored yet.
    if (!isSeamThreadableSlot(slotKey)) {
      return {
        warning: {
          code: "slot_runner_pin_not_threaded",
          slotKey,
          message: `slot "${slotKey}" pins runner "${target.runnerId}" but the launch seam threads only session-slot pins yet; this pin is not honored and the run uses the default runner chain`,
        },
      };
    }

    return {};
  }

  // Typed intent: the launch seam threads only mode==="runner" hard-pins into
  // run_sessions (launch-seam.ts sessionRunnerOverridesFromRecipe), so a
  // satisfiable intent is NOT resolved to its host — the run falls back to the
  // platform default runner chain. Surface that as a WARNING on EVERY
  // satisfiable intent (exact OR same-capability), never a silent pass, so a
  // model-comparison author sees the variant will run on the default runner and
  // not its declared intent. A total absence of any enabled+ready host
  // candidate is still a hard refusal.
  const candidates = runnerIntentCandidates(
    target.config,
    runners as RunnerCatalogEntry[],
  );

  if (candidates.exact.length > 0 || candidates.sameCapability.length > 0) {
    return {
      warning: {
        code: "slot_intent_soft_mismatch",
        slotKey,
        message: `slot "${slotKey}" intent (capability ${target.config.capability_agent}${
          target.config.model ? `, model ${target.config.model}` : ""
        }) is not threaded by the launch seam yet; the run uses the default runner chain, not this slot's intent`,
      },
    };
  }

  return {
    refusal: {
      code: "slot_intent_unsatisfiable",
      message: `slot "${slotKey}" intent has no enabled+ready host runner with capability ${target.config.capability_agent}`,
    },
  };
}

// Preflight a controlled recipe against the live contracts. Pure: no I/O, no
// mutation. Aggregates ALL refusals (not fail-fast) so the UI can surface the
// full remediation set at once; `ok` is true only when there are zero refusals.
export function preflightControlledRecipe(
  input: PreflightInput,
): PreflightResult {
  const { recipe, study, flow, method, runners, overlayCatalog } = input;
  const refusals: PreflightRefusal[] = [];
  const warnings: PreflightWarning[] = [];

  // 1. Ownership — same project (D16, D2). A cross-project Flow revision is
  // rejected before anything else; task binding lives on the Study.
  if (flow.projectId !== study.projectId) {
    refusals.push({
      code: "ownership_mismatch",
      message: `flow revision belongs to project ${flow.projectId}, not the study's project ${study.projectId}`,
    });
  }
  if (recipe.flow.flowRevisionId !== flow.flowRevisionId) {
    refusals.push({
      code: "ownership_mismatch",
      message: `recipe pins flow revision ${recipe.flow.flowRevisionId} but the resolved live revision is ${flow.flowRevisionId}`,
    });
  }

  // 2. Flow launchability / trust / engine / schema (the standard launch chain).
  if (!flow.trusted) {
    refusals.push({
      code: "flow_untrusted",
      message: `flow "${flow.flowRefId}" package is not trusted`,
    });
  }
  if (!flow.enablementLaunchable) {
    refusals.push({
      code: "flow_not_launchable",
      message: `flow "${flow.flowRefId}" is not in a launchable enablement state`,
    });
  }
  if (!flow.engineCompatible) {
    refusals.push({
      code: "engine_incompatible",
      message: `flow "${flow.flowRefId}" declares an engine range incompatible with the platform`,
    });
  }
  if (!flow.schemaVersionSupported) {
    refusals.push({
      code: "schema_version_unsupported",
      message: `flow "${flow.flowRefId}" manifest schema version is unsupported`,
    });
  }

  // 3. Contract-digest drift — a stale package revision (D16). The recipe froze
  // the input/artifact contract digests; if the live revision no longer matches,
  // refuse rather than launch against a drifted contract.
  const liveInputDigest = computeInputContractDigest(flow);
  const liveArtifactDigest = computeArtifactContractDigest(flow);

  if (recipe.flow.inputContractDigest !== liveInputDigest) {
    refusals.push({
      code: "input_contract_drift",
      message: `flow input contract changed since the recipe was frozen (stale package revision)`,
    });
  }
  if (recipe.flow.artifactContractDigest !== liveArtifactDigest) {
    refusals.push({
      code: "artifact_contract_drift",
      message: `flow output/artifact contract changed since the recipe was frozen (stale package revision)`,
    });
  }

  // 4. Input/form compatibility — EXACT (D16, no coercion). Every supplied form
  // value must be a known Flow field; every required Flow field must be supplied.
  const knownFields = new Set(flow.formKnownFields);

  for (const field of Object.keys(recipe.inputs.formValues)) {
    if (!knownFields.has(field)) {
      refusals.push({
        code: "form_field_unknown",
        message: `input form field "${field}" is not declared by the selected Flow`,
      });
    }
  }
  for (const required of flow.formRequiredFields) {
    if (!(required in recipe.inputs.formValues)) {
      refusals.push({
        code: "form_required_missing",
        message: `required Flow form field "${required}" is not supplied by the recipe`,
      });
    }
  }

  // 5. Artifact contract covers the Method's evidence requirements (D16).
  const produced = new Set(flow.producedArtifactKinds);

  for (const requiredKind of method.requiredArtifactKinds) {
    if (!produced.has(requiredKind)) {
      refusals.push({
        code: "artifact_requirement_uncovered",
        message: `method ${method.qualifiedId} requires evidence artifact "${requiredKind}" which the Flow does not produce`,
      });
    }
  }

  // 6. Slot resolution — every bound slot is a declared Flow slot and resolves;
  // every REQUIRED Flow slot is bound (or resolvable via the default chain, which
  // the launch resolver owns — here we only refuse an explicitly-unbound required
  // slot that has no binding at all).
  const declaredSlots = new Set(flow.slotKeys);

  for (const [slotKey, target] of Object.entries(recipe.slotBindings)) {
    if (!declaredSlots.has(slotKey)) {
      refusals.push({
        code: "slot_unknown",
        message: `recipe binds slot "${slotKey}" which the Flow does not declare`,
      });

      continue;
    }

    const { refusal, warning } = checkSlotTarget(slotKey, target, runners);

    if (refusal) refusals.push(refusal);
    if (warning) warnings.push(warning);
  }

  for (const requiredSlot of flow.requiredSlotKeys) {
    if (!(requiredSlot in recipe.slotBindings)) {
      refusals.push({
        code: "slot_unbound",
        message: `required Flow slot "${requiredSlot}" has no runner binding in the recipe`,
      });
    }
  }

  // 7. Capability overlay refs are known (D16, no strict capability degrades).
  const overlay = recipe.capabilityOverlay;

  if (overlay) {
    for (const cls of ["rules", "skills", "mcps", "subagents"] as const) {
      const delta = overlay[cls];

      if (!delta) continue;
      const known = overlayClassRefs(overlayCatalog, cls);

      for (const ref of [...(delta.add ?? []), ...(delta.remove ?? [])]) {
        if (!known.has(ref)) {
          refusals.push({
            code: "overlay_ref_unknown",
            message: `capability overlay ${cls} ref "${ref}" is not in the project catalog`,
          });
        }
      }
    }
  }

  // 8. Codex-1 (C) co-evolve boundary: recipe axes that are DECLARED but not
  // threaded by the launch seam — a variant binding them runs WITHOUT them.
  // WARN on each (never a silent pass, mirroring slot_runner_pin_not_threaded);
  // the standardization gate refuses such recipes as un-standardizable.
  const axisWarning = (axis: NonNullable<PreflightWarning["axis"]>): void => {
    warnings.push({
      code: "recipe_axis_not_threaded",
      axis,
      message: `recipe axis "${axis}" is declared but not threaded by the launch seam yet; the variant runs without it`,
    });
  };

  if (overlay) axisWarning("capabilityOverlay");
  if (recipe.materializationIntent.packagePins.length > 0) {
    axisWarning("packagePins");
  }
  if (recipe.nodeAgentBindings.length > 0) axisWarning("nodeAgentBindings");
  if (recipe.budgets && Object.keys(recipe.budgets).length > 0) {
    axisWarning("budgets");
  }

  return { ok: refusals.length === 0, refusals, warnings };
}
