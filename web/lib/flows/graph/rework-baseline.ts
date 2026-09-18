import { NON_CORRECTION_DECISIONS } from "@/lib/flows/graph/attempt-decisions";

// ADR-118: effective attempt count for a rework-loop node.
//
// `node_attempts.rework_baseline` (NULL ⇒ 0) is the attempt number at which the
// node's CURRENT rework epoch began. Subtracting it from the 1-based attempt
// number yields the per-epoch count the loop bounds against — so a human-driven
// counter reset (`rework.resetTargets`) re-baselines the node to a fresh
// `maxLoops` budget without mutating the append-only attempt numbers.
//
// Total allowed per epoch = `maxLoops + 1` (the initial visit + maxLoops
// reworks); exhaustion fires when `effective > maxLoops`. A node that never
// resets has a NULL baseline everywhere → effective == attemptNumber → behavior
// byte-identical to pre-ADR-118.
//
// ADR-161: OPERATOR node restarts are subtracted too. An operator stepping in to
// correct a wandering agent is human intervention, not a failed automated
// iteration — charging it to `rework.maxLoops` would let a reviewer exhaust a
// flow's rework allowance by HELPING it. The bound is not removed, only moved:
// operator restarts are capped per run by `MAISTER_MAX_OPERATOR_RESTARTS`.
// A run with zero operator restarts passes 0 here and is byte-identical to
// pre-ADR-161.
//
// ADR-175: crash RECOVERS are subtracted on the same reasoning and by the same
// term — a crash advanced the attempt counter without any automated iteration
// failing, so charging it here would let a crash-loop silently exhaust a flow's
// rework allowance. Unlike an operator restart it is deliberately NOT capped by
// `MAISTER_MAX_OPERATOR_RESTARTS`: a crash is not an operator action.
export function effectiveAttempts(
  attemptNumber: number,
  baseline: number | null | undefined,
  nonCorrections: number = 0,
): number {
  return attemptNumber - (baseline ?? 0) - nonCorrections;
}

// Count a node's attempts closed WITHOUT a failed automated iteration — an
// operator interrupt (ADR-161) or a crash recover (ADR-175). Pure so the bound
// check stays unit-testable without Postgres.
//
// A SET, not a single value: the two share every accounting rule, and a filter
// that names one member is how the next provenance decision gets missed.
export function nonCorrectionAttemptCount(
  attempts: ReadonlyArray<{ nodeId: string; decision: string | null }>,
  nodeId: string,
): number {
  return attempts.filter(
    (a) =>
      a.nodeId === nodeId &&
      a.decision !== null &&
      NON_CORRECTION_DECISIONS.includes(a.decision),
  ).length;
}
