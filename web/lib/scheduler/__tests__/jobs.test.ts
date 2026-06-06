import { describe, expect, it } from "vitest";

import {
  computeNextRunAt,
  schedulerBudgetForKind,
  type SchedulerJobKind,
} from "@/lib/scheduler/jobs";

describe("computeNextRunAt", () => {
  it("collapses missed intervals into one catch-up fire", () => {
    const nextRunAt = computeNextRunAt({
      previousNextRunAt: new Date("2026-06-05T10:00:00.000Z"),
      now: new Date("2026-06-05T10:17:30.000Z"),
      cadenceIntervalSeconds: 300,
    });

    expect(nextRunAt.toISOString()).toBe("2026-06-05T10:20:00.000Z");
  });

  it("schedules the next cadence when the current fire was on time", () => {
    const nextRunAt = computeNextRunAt({
      previousNextRunAt: new Date("2026-06-05T10:00:00.000Z"),
      now: new Date("2026-06-05T10:00:00.000Z"),
      cadenceIntervalSeconds: 60,
    });

    expect(nextRunAt.toISOString()).toBe("2026-06-05T10:01:00.000Z");
  });

  it("rejects non-positive cadences", () => {
    expect(() =>
      computeNextRunAt({
        previousNextRunAt: new Date("2026-06-05T10:00:00.000Z"),
        now: new Date("2026-06-05T10:00:00.000Z"),
        cadenceIntervalSeconds: 0,
      }),
    ).toThrow(/cadence/i);
  });
});

describe("schedulerBudgetForKind", () => {
  it("keeps flow_run on the existing flow cap and gives agents their own cap", () => {
    const kinds = [
      "system_sweep",
      "command",
      "agent_tick",
      "flow_run",
    ] satisfies SchedulerJobKind[];

    expect(kinds.map((kind) => [kind, schedulerBudgetForKind(kind)])).toEqual([
      ["system_sweep", "system_sweep"],
      ["command", "command"],
      ["agent_tick", "agent"],
      ["flow_run", "flow"],
    ]);
  });
});
