// Domain-event kind taxonomy v1 (ADR-086). Extension rule: one entry here +
// emit site(s) in the owning domain transaction + one doc row + a CHECK update
// via migration. `task.triage_requeued` is registered with NO emitter — it
// lands with the Stage-3 triager.
export const DOMAIN_EVENT_KINDS = [
  "task.created",
  "task.comment_added",
  "task.triage_requeued",
  "run.done",
  "run.failed",
  "run.crashed",
  "run.abandoned",
  // M36 (ADR-097): a DELEGATED child reaching Review (a diff awaiting the
  // coordinator). NOT terminal in the base FSM (Review → Done via promote) —
  // it wakes a parked orchestrator so it can collect/promote/rework, and it
  // drives as-plan auto-promote. Emitted only when the run has a parent_run_id.
  "run.review",
  "gate.failed",
] as const;

export type DomainEventKind = (typeof DOMAIN_EVENT_KINDS)[number];

export function isDomainEventKind(value: string): value is DomainEventKind {
  return (DOMAIN_EVENT_KINDS as readonly string[]).includes(value);
}

// M36 (ADR-095): run-terminal kinds whose payload MUST carry the emitting run's
// `parent_run_id` so the orchestrator auto-launcher + resume consumer can route
// to the parent. Enforced at the `emitDomainEvent` type boundary.
export const RUN_TERMINAL_EVENT_KINDS = [
  "run.done",
  "run.failed",
  "run.crashed",
  "run.abandoned",
] as const satisfies readonly DomainEventKind[];

export type RunTerminalEventKind = (typeof RUN_TERMINAL_EVENT_KINDS)[number];

export function isRunTerminalEventKind(
  value: string,
): value is RunTerminalEventKind {
  return (RUN_TERMINAL_EVENT_KINDS as readonly string[]).includes(value);
}

// M36 (ADR-097): the run-terminal kinds PLUS `run.review` — the "child has
// settled" set the orchestrator resume consumer reacts to. A child is settled
// once it reaches a terminal state OR Review (a diff awaiting the coordinator).
// Every settled kind carries `parent_run_id` (enforced at the emit boundary).
export const RUN_SETTLED_EVENT_KINDS = [
  ...RUN_TERMINAL_EVENT_KINDS,
  "run.review",
] as const satisfies readonly DomainEventKind[];

export type RunSettledEventKind = (typeof RUN_SETTLED_EVENT_KINDS)[number];

export function isRunSettledEventKind(
  value: string,
): value is RunSettledEventKind {
  return (RUN_SETTLED_EVENT_KINDS as readonly string[]).includes(value);
}
