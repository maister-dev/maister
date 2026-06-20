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
