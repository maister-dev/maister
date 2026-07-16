import { describe, expect, it } from "vitest";

import {
  assertTransition,
  canTransition,
  eventTypeForTransition,
  isTerminalExecutionStatus,
} from "@/lib/evaluations/dispatcher/fsm";

describe("evaluation execution FSM", () => {
  it("allows the forward lifecycle path", () => {
    expect(canTransition("queued", "capturing")).toBe(true);
    expect(canTransition("capturing", "checking")).toBe(true);
    expect(canTransition("checking", "judging")).toBe(true);
    expect(canTransition("judging", "aggregating")).toBe(true);
    expect(canTransition("aggregating", "completed")).toBe(true);
  });

  it("forbids illegal jumps and throws CONFIG on assert", () => {
    expect(canTransition("queued", "completed")).toBe(false);
    expect(() => assertTransition("queued", "judging")).toThrow(/illegal/);
  });

  it("does not allow cancelling out of the computational aggregating state", () => {
    expect(canTransition("aggregating", "cancelling")).toBe(false);
  });

  it("terminal states have no outgoing edges", () => {
    for (const t of ["completed", "partial", "failed", "cancelled"] as const) {
      expect(isTerminalExecutionStatus(t)).toBe(true);
      expect(canTransition(t, "queued")).toBe(false);
    }
  });

  it("emits a distinct event per waiting transition", () => {
    expect(eventTypeForTransition("queued", "capturing")).toBe(
      "evidence.capture_started",
    );
    expect(eventTypeForTransition("capturing", "checking")).toBe(
      "evidence.snapshot_sealed",
    );
    expect(eventTypeForTransition("judging", "aggregating")).toBe(
      "panel.quorum_reached",
    );
    expect(eventTypeForTransition("aggregating", "completed")).toBe(
      "evaluation.completed",
    );
    expect(eventTypeForTransition("checking", "cancelling")).toBe(
      "evaluation.cancelling",
    );
  });
});
