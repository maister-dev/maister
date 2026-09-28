import type { EmitDomainEventInput } from "@/lib/domain-events/outbox";

import { describe, expect, it } from "vitest";

import {
  ATTENTION_EVENT_KINDS,
  causeReason,
  parseTerminalCause,
  terminalCauseReason,
  TERMINAL_CAUSE_REASONS,
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

// B6 (ADR-177 amendment 2026-09-26): a run that ends Failed, Crashed or
// Abandoned says why. Presence is the compiler's job — these pins fail the
// typecheck, not the run, when the discriminant loosens.
describe("terminal cause", () => {
  it("a failure kind cannot be emitted without a cause, and run.done cannot carry one", () => {
    const base = {
      db: null,
      projectId: "p",
      actor: { type: "system" as const, id: null },
      parentRunId: null,
      payload: {},
    };
    // @ts-expect-error — a run.failed | run.crashed | run.abandoned emit names its cause.
    const missing: EmitDomainEventInput = { ...base, kind: "run.failed" };
    const extra: EmitDomainEventInput = {
      ...base,
      kind: "run.done",
      // @ts-expect-error — run.done carries no cause.
      cause: { code: null, source: "graph" },
    };
    const named: EmitDomainEventInput = {
      ...base,
      kind: "run.crashed",
      cause: { code: "CRASH", reason: "turn_lost", source: "graph" },
    };

    expect([missing, extra, named].map((input) => input.kind)).toEqual([
      "run.failed",
      "run.done",
      "run.crashed",
    ]);
  });

  it("reason tokens are snake_case, and a stored cause keeps its code when its reason is free text", () => {
    expect(causeReason("agent-session-gone")).toBe("agent_session_gone");
    expect(causeReason("supervisor-EXECUTOR_UNAVAILABLE")).toBe(
      "supervisor_executor_unavailable",
    );
    expect(
      parseTerminalCause({
        code: "BUDGET_EXCEEDED",
        reason: "budget_breach",
        source: "sweeper",
      }),
    ).toEqual({
      code: "BUDGET_EXCEEDED",
      reason: "budget_breach",
      source: "sweeper",
    });
    expect(
      parseTerminalCause({
        code: null,
        reason: "cascade/user",
        source: "orchestrator",
      }),
    ).toEqual({ code: null, reason: "cascade/user", source: "orchestrator" });
    // The reason is dropped, never the whole cause: its code still says why.
    expect(
      parseTerminalCause({
        code: "CRASH",
        reason: "adapter exited with code 1",
        source: "graph",
      }),
    ).toEqual({ code: "CRASH", source: "graph" });
    expect(parseTerminalCause({ code: "NOPE", source: "graph" })).toBeNull();
    expect(parseTerminalCause({ code: null, source: "elsewhere" })).toBeNull();
  });

  // D-B1: the write keeps a token and nothing else — `cause` reaches agent
  // prompts and `distill`, so a message must never ride it.
  it("the write-side normalizer keeps a token, strips a message suffix and refuses prose", () => {
    expect(terminalCauseReason("prompt-failed:Session 3f1c not found")).toBe(
      "prompt_failed",
    );
    expect(terminalCauseReason("cascade/user_stopped")).toBe(
      "cascade/user_stopped",
    );
    expect(terminalCauseReason("project row vanished before spawn")).toBe(
      undefined,
    );
    expect(terminalCauseReason("a".repeat(65))).toBe(undefined);
    expect(terminalCauseReason(undefined)).toBe(undefined);
    // Every registered token survives the normalizer unchanged.
    for (const token of TERMINAL_CAUSE_REASONS)
      expect(terminalCauseReason(token)).toBe(token);
  });
});

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
