import "server-only";

import type { LaunchRunSeam } from "@/lib/evaluations/launch-batch";
import type { LaunchRunContext } from "@/lib/services/runs";

import { launchRun } from "@/lib/services/runs";

// The default LaunchRunSeam adapter (ADR-149 T1.2). Turns one controlled-launch
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
// CO-EVOLVE (T6.2 materialization threading): per-recipe slot-runner overrides,
// the capability overlay, and the pinned flow-revision are NOT yet threaded —
// `launchRun` does not accept the per-session runner map a recipe carries. Until
// that lands, a launched variant runs on the task's default flow/runner; the
// recipe's executionPolicy IS applied. Preflight already refuses an incompatible
// recipe, so this is a fidelity gap, not a safety one.
export function defaultLaunchRunSeam(ctx: LaunchRunContext): LaunchRunSeam {
  return async (args) => {
    const { runId } = await launchRun(
      {
        taskId: args.taskId,
        allowConcurrent: true,
        autoPromote: false,
        evaluationStudyId: args.studyId,
        evaluationBatchItemId: args.launchKey,
        executionPolicy: args.recipeDefinition.executionPolicy,
      },
      ctx,
    );

    return { runId };
  };
}
