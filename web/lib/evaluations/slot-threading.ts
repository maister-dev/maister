// The launch seam (launch-seam.ts `sessionRunnerOverridesFromRecipe`) threads a
// recipe's hard-pinned runner into `run_sessions` ONLY for `session:`-prefixed
// slots. Other slot families (e.g. `consensus:<node>:<participant>`) are not
// threaded yet (co-evolve), so a runner pin on such a slot is silently NOT
// honored and the run falls back to the default runner chain. This predicate is
// the single source of truth both the seam (which pins it threads) and preflight
// (which pins it must WARN are un-honored) consume, so the two never drift.
export function isSeamThreadableSlot(slotKey: string): boolean {
  return slotKey.startsWith("session:");
}
