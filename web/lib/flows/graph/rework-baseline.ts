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
export function effectiveAttempts(
  attemptNumber: number,
  baseline: number | null | undefined,
): number {
  return attemptNumber - (baseline ?? 0);
}
