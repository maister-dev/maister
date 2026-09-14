// Domain-event kind taxonomy v1 (ADR-086). Extension rule: one entry here +
// emit site(s) in the owning domain transaction + one doc row + a CHECK update
// via migration. `task.triage_requeued` is registered with NO emitter — it
// lands with the Stage-3 triager.
export const DOMAIN_EVENT_KINDS = [
  "task.created",
  "task.comment_added",
  "task.triage_requeued",
  "task.clarification_answered",
  "run.done",
  "run.failed",
  "run.crashed",
  "run.abandoned",
  // M37 (ADR-100): a DELEGATED child reaching Review (a diff awaiting the
  // coordinator). NOT terminal in the base FSM (Review → Done via promote) —
  // it wakes a parked orchestrator so it can collect/promote/rework, and it
  // drives as-plan auto-promote. Emitted only when the run has a parent_run_id.
  "run.review",
  // M51 (ADR-169 amendment, migration 0167): the two ways a DECISION opens,
  // neither of which the bus could represent before.
  //
  // `run.review_opened` is the COMPLEMENT of `run.review` above: ADR-100 scoped
  // that kind to runs WITH a parent because its consumer is the orchestrator
  // resume, so a TOP-LEVEL run reaching Review — the commonest promotable
  // decision there is — emitted nothing at all. Widening `run.review` instead
  // would have redefined a shipped decision and silently enlarged three
  // consumer populations (the orchestrator, the ext activity pulse, and the
  // `updates` counter); a sibling kind disturbs none of them. Together the two
  // cover every entry into Review.
  "run.review_opened",
  // A run blocked on a human answer. Emitted by `createHitlRequest`, which is
  // the ONLY writer of `hitl_requests` — there were fifteen before, and a
  // missed one is a decision nobody is told about.
  "run.needs_input",
  // Execution-policy axis (B3): a run escalated for human attention. ADR-161's
  // operator node interrupt REUSES this kind with `reason: "node_interrupt"` —
  // an operator pausing a node is an escalation like any other, so it needs no
  // taxonomy entry and no CHECK change.
  "run.escalated",
  // ADR-160: an operator took a finished `Review` run back for rework, and
  // returned it. Distinct lifecycle facts (not escalations), so unlike the
  // interrupt they DO get their own kinds — migration `0125` widens the CHECK.
  // Deliberately absent from RUN_TERMINAL_EVENT_KINDS / RUN_SETTLED_EVENT_KINDS
  // below: a claim must never make an orchestrator treat a child as settled.
  "run.rework_claimed",
  "run.rework_returned",
  "gate.failed",
] as const;

export type DomainEventKind = (typeof DOMAIN_EVENT_KINDS)[number];

export function isDomainEventKind(value: string): value is DomainEventKind {
  return (DOMAIN_EVENT_KINDS as readonly string[]).includes(value);
}

// M37 (ADR-098): run-terminal kinds whose payload MUST carry the emitting run's
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

// M37 (ADR-100): the run-terminal kinds PLUS `run.review` — the "child has
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

// ADR-163 (Codex review F1): WHY a delegated child entered `Review`, carried on
// the `run.review` payload. An operator stop, a released rework claim and a
// sync-resolver return all park a child in Review through the SAME helper as
// graph completion, so without a cause the as-plan auto-promote consumer read
// a stopped child's partial diff as finished work and merged it. Required on
// the emit helper so a new Review path cannot default to "completed".
export const RUN_REVIEW_CAUSES = [
  "graph_completed",
  "agent_exit",
  "operator_stop",
  "rework_released",
  "sync_returned",
] as const;

export type RunReviewCause = (typeof RUN_REVIEW_CAUSES)[number];

// The allow-list the auto-promote consumer applies — fail-closed: a cause that
// is missing (an event emitted before the field existed, redelivered
// at-least-once) or unknown leaves the child in Review for a human promote.
export const AUTO_PROMOTABLE_REVIEW_CAUSES = [
  "graph_completed",
  "agent_exit",
] as const satisfies readonly RunReviewCause[];

export function isAutoPromotableReviewCause(
  value: unknown,
): value is (typeof AUTO_PROMOTABLE_REVIEW_CAUSES)[number] {
  return (
    typeof value === "string" &&
    (AUTO_PROMOTABLE_REVIEW_CAUSES as readonly string[]).includes(value)
  );
}

// M51 (ADR-169): the taxonomy split the attention plane reads by. Three kinds
// are written in the SAME transaction as a `task_activity` row carrying the
// same fact — `task.created` (`lib/services/tasks.ts`), `task.comment_added`
// (`lib/social/comments.ts`) and `task.triage_requeued`
// (`lib/services/triage.ts`). Counting those in `updates` makes one task
// creation score two, and rendering them in the feed prints the same line
// twice, so the attention plane reads the complement instead.
//
// `task.clarification_answered` has NO twin — answering an agent's question is
// visible nowhere else — which is why this is a classification and not simply
// "the run.* axis".
export const TASK_ACTIVITY_TWINNED_EVENT_KINDS = [
  "task.created",
  "task.comment_added",
  "task.triage_requeued",
] as const satisfies readonly DomainEventKind[];

export type TaskActivityTwinnedEventKind =
  (typeof TASK_ACTIVITY_TWINNED_EVENT_KINDS)[number];

// Spelled out rather than derived so a NEW taxonomy kind lands in neither list
// and `UT-ATN-09` fails — either default (silently counted, silently invisible)
// would be a bug nobody notices.
export const ATTENTION_EVENT_KINDS = [
  "task.clarification_answered",
  "run.done",
  "run.failed",
  "run.crashed",
  "run.abandoned",
  "run.review",
  "run.escalated",
  "run.rework_claimed",
  "run.rework_returned",
  "gate.failed",
] as const satisfies readonly DomainEventKind[];

export type AttentionEventKind = (typeof ATTENTION_EVENT_KINDS)[number];

/**
 * The kinds that can move the `decisions` COUNT — deliberately NOT members of
 * `ATTENTION_EVENT_KINDS`.
 *
 * That list is the `updates` population ("what happened that I have not seen")
 * and the activity feed's. A decision opening is already counted by `decisions`,
 * and ADR-169 exists to keep the two numbers separate populations; folding these
 * into `ATTENTION_EVENT_KINDS` would have every new HITL increment BOTH badges
 * for one fact — the same double-count D2's mention MINUS exists to prevent.
 *
 * The attention consumer wakes on the union of the two lists.
 */
export const DECISION_OPENING_EVENT_KINDS = [
  "run.review_opened",
  "run.needs_input",
] as const satisfies readonly DomainEventKind[];

export type DecisionOpeningEventKind =
  (typeof DECISION_OPENING_EVENT_KINDS)[number];

/**
 * Every kind the attention plane REACTS to — the union of the two lists above.
 *
 * Counting and invalidating are different questions, and conflating them is
 * what made `/work` go stale: the stream's changed-project scan reused
 * `ATTENTION_EVENT_KINDS`, which is the `updates` POPULATION and therefore
 * deliberately excludes the decision openings. A top-level run entering Review
 * then moved nothing the scan could see, and for a reader whose `decisions`
 * count did not move with it — a project viewer, whose count is always zero —
 * no tick was emitted at all while the connection still reported Live.
 *
 * Over-invalidating costs one refetch; under-invalidating costs a page that
 * silently lies. So the scan reads the union and the counter keeps the split.
 */
export const ATTENTION_PLANE_EVENT_KINDS = [
  ...ATTENTION_EVENT_KINDS,
  ...DECISION_OPENING_EVENT_KINDS,
] as const satisfies readonly DomainEventKind[];

export type AttentionPlaneEventKind =
  (typeof ATTENTION_PLANE_EVENT_KINDS)[number];
