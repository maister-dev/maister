import { describe, expect, it } from "vitest";

import {
  DOMAIN_EVENT_KINDS,
  isDomainEventKind,
  isRunSettledEventKind,
  isRunTerminalEventKind,
  RUN_SETTLED_EVENT_KINDS,
} from "@/lib/domain-events/taxonomy";

describe("domain-event taxonomy", () => {
  it("contains exactly the 13 taxonomy kinds (ADR-086, ADR-136, run.review, B3 run.escalated, ADR-159 rework round-trip)", () => {
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
      "run.escalated",
      "run.rework_claimed",
      "run.rework_returned",
      "gate.failed",
    ]);
  });

  // ADR-159: a claim/return is a lifecycle fact, NOT a settled child. Adding
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
