import "server-only";

import type { LaunchRunSeam } from "@/lib/evaluations/launch-batch";
import type { LaunchRunContext } from "@/lib/services/runs";

import { MaisterError } from "@/lib/errors";
import { livePreflightLoaders } from "@/lib/evaluations/preflight-loaders";
import { preflightStudyRecipe } from "@/lib/evaluations/recipes";
import { isSeamThreadableSlot } from "@/lib/evaluations/slot-threading";
import { launchRun } from "@/lib/services/runs";

// The default LaunchRunSeam adapter (ADR-150 T1.2). Turns one controlled-launch
// batch item into a real flow run through the shared `launchRun` path, carrying
// the two properties the batch FSM's correctness depends on:
//
//  1. FORCED HOLD — `evaluationStudyId` makes `launchRun` stamp the
//     `evaluation_study` promotion hold (independent of `autoPromote`), so a
//     launched participant can never auto-promote/auto-deliver and the DELETE
//     hold route refuses clearing it while the study is live.
//  2. IDEMPOTENCY — `evaluationBatchItemId` (the seam's `launchKey`) is written
//     INSIDE the run INSERT under a partial UNIQUE, so a re-driven item ADOPTS
//     the existing run rather than launching a second one. This is the contract
//     the batch lib's crash-recovery paths converge under (an adversarial pass
//     proved a post-hoc lookup double-launches).
//
// `autoPromote: false` records the launch opt-out; `allowConcurrent: true`
// lets N variants × replicates run off one task past the single-active gate.
//
// Materialization: the recipe's HARD-PIN slot bindings (`mode: "runner"`) are
// threaded as per-session runner overrides, so a launched variant runs on its
// recipe's chosen runners. Slot keys are `session:<name>` / `consensus:...`;
// only `session:` slots (`isSeamThreadableSlot`) map to a run session override.
// A `mode: "runner"` pin on a non-`session:` slot (e.g. a `consensus:`
// participant) and INTENT-mode bindings (`mode: "intent"`) are NOT threaded here
// — both fall back to launchRun's default runner chain (resolving a typed intent
// or a consensus-slot host needs the live catalog and is the remaining
// co-evolve). Codex-1 (C): the recipe's pinned flow revision and frozen form
// inputs ARE threaded (`evaluationFlowRevisionId` / `evaluationFormInputs`), so
// a variant executes ITS recipe's revision with ITS inputs — the passport is
// honored by construction, not merely recorded. The still-unthreaded axes
// (capabilityOverlay, materializationIntent.packagePins, nodeAgentBindings,
// budgets) surface as `recipe_axis_not_threaded` preflight warnings and make
// the recipe UN-standardizable — never a silent pass.
function sessionRunnerOverridesFromRecipe(
  recipe: LaunchRunSeamArgs["recipeDefinition"],
): Record<string, string> {
  const overrides: Record<string, string> = {};

  for (const [slotKey, target] of Object.entries(recipe.slotBindings)) {
    if (target.mode === "runner" && isSeamThreadableSlot(slotKey)) {
      overrides[slotKey.slice("session:".length)] = target.runnerId;
    }
  }

  return overrides;
}

type LaunchRunSeamArgs = Parameters<LaunchRunSeam>[0];

export function defaultLaunchRunSeam(ctx: LaunchRunContext): LaunchRunSeam {
  return async (args) => {
    // Codex-1 step 9: re-run live preflight immediately before the first launch
    // side effect, fail-closed on every hard refusal. A `recipeId` batch item
    // was vetted only at recipe CREATION — trust, enablement, contract digests,
    // and runner availability can all drift before (or between) drives.
    const verdict = await preflightStudyRecipe(
      {
        studyId: args.studyId,
        projectId: args.projectId,
        definition: args.recipeDefinition,
      },
      livePreflightLoaders(),
    );

    if (!verdict.ok) {
      throw new MaisterError(
        "CONFIG",
        `controlled launch preflight failed: ${verdict.refusals
          .map((r) => r.code)
          .join(", ")}`,
      );
    }

    const sessionRunnerOverrides = sessionRunnerOverridesFromRecipe(
      args.recipeDefinition,
    );
    const formValues = args.recipeDefinition.inputs.formValues;

    const { runId } = await launchRun(
      {
        taskId: args.taskId,
        allowConcurrent: true,
        autoPromote: false,
        evaluationStudyId: args.studyId,
        evaluationBatchItemId: args.launchKey,
        // Codex-1 step 8: the run pins + executes the RECIPE's flow revision
        // (never the task's live enabled one) with the recipe's frozen form
        // inputs pre-written as its input artifacts.
        evaluationFlowRevisionId: args.recipeDefinition.flow.flowRevisionId,
        ...(Object.keys(formValues).length
          ? { evaluationFormInputs: formValues }
          : {}),
        executionPolicy: args.recipeDefinition.executionPolicy,
        ...(Object.keys(sessionRunnerOverrides).length
          ? { sessionRunnerOverrides }
          : {}),
      },
      ctx,
    );

    return { runId };
  };
}
