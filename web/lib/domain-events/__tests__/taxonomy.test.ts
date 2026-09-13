import { describe, expect, it } from "vitest";

import {
  ATTENTION_EVENT_KINDS,
  DECISION_OPENING_EVENT_KINDS,
  AUTO_PROMOTABLE_REVIEW_CAUSES,
  DOMAIN_EVENT_KINDS,
  isAutoPromotableReviewCause,
  isDomainEventKind,
  isRunSettledEventKind,
  isRunTerminalEventKind,
  RUN_REVIEW_CAUSES,
  RUN_SETTLED_EVENT_KINDS,
  TASK_ACTIVITY_TWINNED_EVENT_KINDS,
} from "@/lib/domain-events/taxonomy";

// ADR-163 (Codex review F1): a `run.review` says WHY the child entered Review.
// Only a completion may drive the as-plan auto-promote; an operator stop, a
// released rework claim or a sync-resolver return park the child for a human.
describe("run.review cause", () => {
  it("only the two completion causes are auto-promotable", () => {
    expect([...AUTO_PROMOTABLE_REVIEW_CAUSES]).toEqual([
      "graph_completed",
      "agent_exit",
    ]);

    for (const cause of RUN_REVIEW_CAUSES) {
      expect(isAutoPromotableReviewCause(cause)).toBe(
        (AUTO_PROMOTABLE_REVIEW_CAUSES as readonly string[]).includes(cause),
      );
    }
  });

  it("a missing or foreign cause is never auto-promotable (fail-closed)", () => {
    expect(isAutoPromotableReviewCause(undefined)).toBe(false);
    expect(isAutoPromotableReviewCause(null)).toBe(false);
    expect(isAutoPromotableReviewCause("")).toBe(false);
    expect(isAutoPromotableReviewCause("operator_stop")).toBe(false);
    expect(isAutoPromotableReviewCause("completed")).toBe(false);
  });
});

describe("domain-event taxonomy", () => {
  it("contains exactly the 15 taxonomy kinds (ADR-086, ADR-136, run.review, B3 run.escalated, ADR-160 rework round-trip, ADR-169 decision-opening)", () => {
    expect([...DOMAIN_EVENT_KINDS]).toEqual([
      "task.created",
      "task.comment_added",
      "task.triage_requeued",
      "task.clarification_answered",
      "run.done",
      "run.failed",
      "run.crashed",
      "run.abandoned",
      "run.review",
      "run.review_opened",
      "run.needs_input",
      "run.escalated",
      "run.rework_claimed",
      "run.rework_returned",
      "gate.failed",
    ]);
  });

  // ADR-160: a claim/return is a lifecycle fact, NOT a settled child. Adding
  // either to the settled set would make an orchestrator collect a claimed
  // child as if it had finished — the same hazard `parent_run_id IS NULL`
  // guards at the claim route, arriving by a different door.
  it("the rework round-trip kinds are neither terminal nor settled", () => {
    for (const kind of ["run.rework_claimed", "run.rework_returned"]) {
      expect(isDomainEventKind(kind)).toBe(true);
      expect(isRunTerminalEventKind(kind)).toBe(false);
      expect(isRunSettledEventKind(kind)).toBe(false);
      expect([...RUN_SETTLED_EVENT_KINDS]).not.toContain(kind);
    }
  });

  // M37 (ADR-100): the settled set = terminal kinds + run.review.
  it("run.review is settled but NOT terminal", () => {
    expect(isRunTerminalEventKind("run.review")).toBe(false);
    expect(isRunSettledEventKind("run.review")).toBe(true);
    expect([...RUN_SETTLED_EVENT_KINDS]).toContain("run.review");
  });

  it("every terminal kind is also settled", () => {
    for (const kind of [
      "run.done",
      "run.failed",
      "run.crashed",
      "run.abandoned",
    ]) {
      expect(isRunTerminalEventKind(kind)).toBe(true);
      expect(isRunSettledEventKind(kind)).toBe(true);
    }
  });

  it("isDomainEventKind accepts every taxonomy kind", () => {
    for (const kind of DOMAIN_EVENT_KINDS) {
      expect(isDomainEventKind(kind)).toBe(true);
    }
  });

  it("isDomainEventKind rejects foreign values", () => {
    expect(isDomainEventKind("run.started")).toBe(false);
    expect(isDomainEventKind("gate.decided")).toBe(false);
    expect(isDomainEventKind("")).toBe(false);
    expect(isDomainEventKind("task.created ")).toBe(false);
  });
});

// UT-ATN-09 (M51, ADR-169) — the attention plane reads `domain_events` through
// a classification, not through a hand-picked prefix. Three kinds are written
// in the same transaction as a `task_activity` row carrying the same fact;
// counting those in `updates` scores one task creation twice and rendering them
// in the feed prints the line twice.
//
// The classification is now THREE-way, not two. `DECISION_OPENING_EVENT_KINDS`
// is the third role: a kind that moves the `decisions` count and therefore must
// NOT also land in `updates` — the same double-count, one counter over. The
// three lists must PARTITION the taxonomy, so a new kind in none of them still
// fails here rather than silently defaulting to "counted" or to "invisible".
describe("UT-ATN-09 attention/twinned partition of the taxonomy", () => {
  it("partitions every taxonomy kind exactly once", () => {
    const union = [
      ...TASK_ACTIVITY_TWINNED_EVENT_KINDS,
      ...ATTENTION_EVENT_KINDS,
      ...DECISION_OPENING_EVENT_KINDS,
    ];

    expect(union.length).toBe(DOMAIN_EVENT_KINDS.length);
    expect([...union].sort()).toEqual([...DOMAIN_EVENT_KINDS].sort());
    expect(new Set(union).size).toBe(union.length);
  });

  it("keeps a decision-opening kind OUT of the updates population", () => {
    // The load-bearing half of the third bucket: a decision opening is already
    // counted by `decisions`, so counting it in `updates` too would light both
    // badges for one fact.
    for (const kind of DECISION_OPENING_EVENT_KINDS) {
      expect([...ATTENTION_EVENT_KINDS]).not.toContain(kind);
      expect([...TASK_ACTIVITY_TWINNED_EVENT_KINDS]).not.toContain(kind);
      expect([...DOMAIN_EVENT_KINDS]).toContain(kind);
    }
  });

  it("classifies the three twinned kinds as twinned, not as attention", () => {
    for (const kind of [
      "task.created",
      "task.comment_added",
      "task.triage_requeued",
    ]) {
      expect([...TASK_ACTIVITY_TWINNED_EVENT_KINDS]).toContain(kind);
      expect([...ATTENTION_EVENT_KINDS]).not.toContain(kind);
    }
  });

  // The one `task.*` kind with no `task_activity` twin. Dropping it because it
  // starts with `task.` would make answering an agent's question invisible
  // everywhere — which is why this is a classification, not a prefix match.
  it("keeps task.clarification_answered on the attention side", () => {
    expect([...ATTENTION_EVENT_KINDS]).toContain("task.clarification_answered");
  });

  it("leaves no run or gate kind invisible to the attention plane", () => {
    // Every `run.*`/`gate.*` fact has to reach the reader through SOMETHING:
    // the `updates` population, or — for a kind that opens a decision and is
    // therefore already counted by `decisions` — the decision-opening list.
    // Landing in neither is the silent case this guards.
    const visible = new Set<string>([
      ...ATTENTION_EVENT_KINDS,
      ...DECISION_OPENING_EVENT_KINDS,
    ]);

    for (const kind of DOMAIN_EVENT_KINDS) {
      if (!kind.startsWith("run.") && kind !== "gate.failed") continue;
      expect([...visible]).toContain(kind);
    }
  });
});
