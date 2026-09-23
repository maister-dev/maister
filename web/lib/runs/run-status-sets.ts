import "server-only";

export {
  RUN_STATUS_VALUES,
  type RunStatusValue,
} from "@/lib/runs/run-status-values";

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

// Workspace retention is intentionally narrower than generic terminality:
// crashed/reviewed runs remain visible and require an explicit user decision
// before their worktrees may be removed. Runtime-object retention and the
// shared-tree removal guard read this set; the worktree GC reads the one below.
export const DISPOSABLE_WORKSPACE_RUN_STATUSES = ["Done", "Abandoned"] as const;

// The statuses whose worktree the retention GC collects — at
// `scheduled_removal_at`, else `gcAgeDays` after `ended_at` — always preserving
// it first (a snapshot commit plus `maister/archive/<runId>`, which Reattach
// restores from). ADR-181 (owner, 2026-09-23): a `Failed` attempt's worktree
// expires like a finished one, or every list that shows it (rail, portfolio,
// project workspaces) grows without bound. Its evidence does not: runtime
// objects stay on the narrower set above.
export const WORKTREE_TTL_RUN_STATUSES = [
  ...DISPOSABLE_WORKSPACE_RUN_STATUSES,
  "Failed",
] as const;

// ADR-165 (D7): a run holds a SCHEDULER SLOT while it is in one of these. It is
// the same list `countLiveRuns` and `sharedWriterSiblingActive` already used
// inline; naming it once is what keeps the per-orchestrator active-children cap
// counting the same population those two do.
//
// Deliberately NOT `WaitingOnChildren` / `NeedsInputIdle` / `Review`: those are
// slot-FREED states (a parked orchestrator has released its slot), so counting
// them would starve the pool.
export const SLOT_HOLDING_RUN_STATUSES = [
  "Running",
  "NeedsInput",
  "HumanWorking",
] as const;

export function isDisposableWorkspaceRunStatus(status: string): boolean {
  return (DISPOSABLE_WORKSPACE_RUN_STATUSES as readonly string[]).includes(
    status,
  );
}

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

// M37 (ADR-102) F2: the FAILURE-terminal statuses — TERMINAL minus `Done`. A
// shared sibling in any of these reached a non-success end with potentially
// partial, unreviewed work on the shared branch. The auto-promoter SKIPS a tree
// containing one (an unattended merge would absorb that work); a human manual
// promote stays allowed (the whole tree-diff is reviewed first).
export const FAILURE_TERMINAL_RUN_STATUSES = [
  "Failed",
  "Crashed",
  "Abandoned",
] as const;

export function isFailureTerminalRunStatus(status: string): boolean {
  return (FAILURE_TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

// A run-bound ext token (orchestrator-run) may not mutate a tree whose
// orchestrator has terminalized (Codex adversarial review, Finding 1).
export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}
