import { describe, expect, it } from "vitest";

import { mapDomainEventToPulseItem } from "@/lib/ext-activity/domain-events";

describe("assistant pulse domain-event mapping", () => {
  it("maps terminal run facts into high-salience pulse items", () => {
    const item = mapDomainEventToPulseItem({
      id: 14n,
      kind: "run.failed",
      occurredAt: new Date("2026-07-26T10:00:00.000Z"),
      runId: "run-1",
      taskId: "task-1",
      taskKey: "OPS-14",
      payload: { runId: "run-1", taskId: "task-1" },
    });

    expect(item).toMatchObject({
      id: "14",
      kind: "run.failed",
      salience: "high",
      runId: "run-1",
      taskKey: "OPS-14",
      action: {
        verb: "finish",
        object: "run",
        outcome: "failed",
      },
    });
    expect(item.summary).toContain("failed");
  });

  it("surfaces gate failures with the gate id when available", () => {
    const item = mapDomainEventToPulseItem({
      id: 22n,
      kind: "gate.failed",
      occurredAt: new Date("2026-07-26T10:05:00.000Z"),
      runId: "run-2",
      taskId: "task-2",
      taskKey: "OPS-22",
      payload: { gateId: "tests" },
    });

    expect(item.salience).toBe("high");
    expect(item.gateId).toBe("tests");
    expect(item.summary).toContain("tests");
  });

  it("uses task references when available for task-side events", () => {
    const item = mapDomainEventToPulseItem({
      id: 31n,
      kind: "task.triage_requeued",
      occurredAt: new Date("2026-07-26T10:10:00.000Z"),
      runId: null,
      taskId: "task-3",
      taskKey: "OPS-31",
      payload: { taskKey: "OPS-31", title: "Investigate outage" },
    });

    expect(item.summary).toContain("OPS-31");
    expect(item.action.object).toContain("task");
  });
});
