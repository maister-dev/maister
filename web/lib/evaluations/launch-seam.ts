import "server-only";

import type { LaunchRunSeam } from "@/lib/evaluations/launch-batch";
import type { LaunchRunContext } from "@/lib/services/runs";

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
// co-evolve); the capabilityOverlay and pinned flow-revision are likewise not
// yet threaded. Preflight WARNS on every intent-mode slot AND every non-session
// runner pin (`slot_runner_pin_not_threaded`) — never a silent pass — so the
// author sees the variant runs on the default runner, not its declared
// runner/intent; the misroute is surfaced, not hidden.
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
    const sessionRunnerOverrides = sessionRunnerOverridesFromRecipe(
      args.recipeDefinition,
    );

    const { runId } = await launchRun(
      {
        taskId: args.taskId,
        allowConcurrent: true,
        autoPromote: false,
        evaluationStudyId: args.studyId,
        evaluationBatchItemId: args.launchKey,
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
