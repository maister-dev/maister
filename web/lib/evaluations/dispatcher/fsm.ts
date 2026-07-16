// Client-safe (pure): the Evaluation Execution lifecycle allow-list + the event
// emitted on each transition (ADR-142 D4/D17). The worker uses EXACT allow-list
// transitions with CAS/version guards; a transition not in this table is a
// CONFIG-shaped refusal, never a silent no-op.

import { MaisterError } from "@/lib/errors";
import {
  EVALUATION_EXECUTION_TERMINAL_STATUSES,
  type EvaluationExecutionStatus,
} from "@/lib/evaluations/types";

// Allowed next states per current state. `aggregating` is a short computational
// state and is NOT cancellable (D4); terminal states have no outgoing edges.
export const EVALUATION_TRANSITIONS: Record<
  EvaluationExecutionStatus,
  readonly EvaluationExecutionStatus[]
> = {
  queued: ["capturing", "cancelling"],
  capturing: ["checking", "failed", "cancelling"],
  checking: ["judging", "partial", "failed", "cancelling"],
  judging: ["aggregating", "cancelling"],
  aggregating: ["completed", "partial", "review_required"],
  review_required: ["completed", "partial"],
  cancelling: ["cancelled"],
  completed: [],
  partial: [],
  failed: [],
  cancelled: [],
};

export function isTerminalExecutionStatus(
  status: EvaluationExecutionStatus,
): boolean {
  return (EVALUATION_EXECUTION_TERMINAL_STATUSES as readonly string[]).includes(
    status,
  );
}

export function canTransition(
  from: EvaluationExecutionStatus,
  to: EvaluationExecutionStatus,
): boolean {
  return EVALUATION_TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: EvaluationExecutionStatus,
  to: EvaluationExecutionStatus,
): void {
  if (!canTransition(from, to)) {
    throw new MaisterError(
      "CONFIG",
      `illegal evaluation execution transition ${from} -> ${to}`,
    );
  }
}

// The durable event emitted on each transition (D17 / AsyncAPI). Every WAITING
// state has an emitter so a client (via replayable SSE) and the recovery path
// both observe progress; there is no hidden polling.
export function eventTypeForTransition(
  from: EvaluationExecutionStatus,
  to: EvaluationExecutionStatus,
): string {
  const key = `${from}->${to}`;

  switch (key) {
    case "queued->capturing":
      return "evidence.capture_started";
    case "capturing->checking":
      return "evidence.snapshot_sealed";
    case "capturing->failed":
      return "evidence.capture_failed";
    case "checking->judging":
      return "objective_check.completed";
    case "checking->partial":
      return "evaluation.partial";
    case "checking->failed":
      return "evaluation.failed";
    case "judging->aggregating":
      return "panel.quorum_reached";
    case "aggregating->completed":
      return "evaluation.completed";
    case "aggregating->partial":
      return "panel.partial";
    case "aggregating->review_required":
      return "review.required";
    case "review_required->completed":
      return "review.resolved";
    case "review_required->partial":
      return "evaluation.partial";
    case "queued->cancelling":
    case "capturing->cancelling":
    case "checking->cancelling":
    case "judging->cancelling":
      return "evaluation.cancelling";
    case "cancelling->cancelled":
      return "evaluation.cancelled";
    default:
      return "evaluation.transition";
  }
}
