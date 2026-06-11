import { describe, expect, it } from "vitest";

import { schedulerBudgetLimits } from "@/lib/scheduler/budgets";
import {
  computeNextRunAt,
  isSchedulerJobKind,
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
      "run_schedule",
      "webhook_delivery",
      "domain_event_dispatch",
    ] satisfies SchedulerJobKind[];

    expect(kinds.map((kind) => [kind, schedulerBudgetForKind(kind)])).toEqual([
      ["system_sweep", "system_sweep"],
      ["command", "command"],
      ["agent_tick", "agent"],
      ["flow_run", "flow"],
      ["run_schedule", "run_schedule"],
      ["webhook_delivery", "webhook_delivery"],
      ["domain_event_dispatch", "domain_event_dispatch"],
    ]);
  });

  it("resolves the webhook_delivery singleton drainer budget to a fixed 1", () => {
    expect(schedulerBudgetForKind("webhook_delivery")).toBe("webhook_delivery");
    expect(schedulerBudgetLimits().webhookDelivery).toBe(1);
  });

  it("resolves the domain_event_dispatch singleton dispatcher budget to a fixed 1", () => {
    expect(schedulerBudgetForKind("domain_event_dispatch")).toBe(
      "domain_event_dispatch",
    );
    expect(schedulerBudgetLimits().domainEventDispatch).toBe(1);
  });
});

describe("isSchedulerJobKind", () => {
  it("accepts webhook_delivery as a registered job kind", () => {
    expect(isSchedulerJobKind("webhook_delivery")).toBe(true);
  });

  it("accepts domain_event_dispatch as a registered job kind", () => {
    expect(isSchedulerJobKind("domain_event_dispatch")).toBe(true);
  });

  it("rejects unknown kinds", () => {
    expect(isSchedulerJobKind("not_a_kind")).toBe(false);
  });
});
