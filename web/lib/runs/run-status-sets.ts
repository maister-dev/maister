import "server-only";

// M37: shared run-status sets for orchestrator child accounting — the single
// source of truth so the three child-pending counters (the orchestrator node's
// completion check, the resume consumer's wake gate, and reconcile's stuck
// detection) can never drift.

// The strictly-terminal run statuses — a run in any of these has reached the end
// of its lifecycle.
export const TERMINAL_RUN_STATUSES = [
  "Done",
  "Failed",
  "Crashed",
  "Abandoned",
] as const;

// M37 (ADR-100): the SETTLED set — terminal statuses PLUS `Review`. A delegated
// child is no longer "pending" for its orchestrator once it is settled: it is
// either terminal, or sitting in `Review` with a diff awaiting the coordinator's
// promote/rework decision. The C-2 completion model uses this set so a parked
// orchestrator can complete (and reconcile can detect a genuinely stuck one) once
// no NON-settled children remain — while the orchestrator is still woken on each
// child's `run.review` (see orchestrator-resume) to act on the diff.
export const SETTLED_RUN_STATUSES = [
  ...TERMINAL_RUN_STATUSES,
  "Review",
] as const;

export function isSettledRunStatus(status: string): boolean {
  return (SETTLED_RUN_STATUSES as readonly string[]).includes(status);
}

// A run-bound ext token (orchestrator-run) may not mutate a tree whose
// orchestrator has terminalized (Codex adversarial review, Finding 1).
export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}
