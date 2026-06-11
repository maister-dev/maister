import { describe, expect, it } from "vitest";

import {
  DOMAIN_EVENT_KINDS,
  isDomainEventKind,
} from "@/lib/domain-events/taxonomy";

describe("domain-event taxonomy", () => {
  it("contains exactly the 8 ADR-085 kinds", () => {
    expect([...DOMAIN_EVENT_KINDS]).toEqual([
      "task.created",
      "task.comment_added",
      "task.triage_requeued",
      "run.done",
      "run.failed",
      "run.crashed",
      "run.abandoned",
      "gate.failed",
    ]);
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
