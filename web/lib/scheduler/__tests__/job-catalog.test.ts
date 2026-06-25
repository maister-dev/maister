import { describe, expect, it } from "vitest";

import {
  ALL_SCHEDULER_JOB_KINDS,
  CREATABLE_SCHEDULER_JOB_KINDS,
  FILTERABLE_SCHEDULER_JOB_KINDS,
  isCreatableSchedulerJobKind,
  isSeededSingletonSchedulerJob,
  isSystemManagedSchedulerJobKind,
  SCHEDULER_JOB_KIND_CATALOG,
} from "@/lib/scheduler/job-catalog";

const ALL_JOB_KINDS = [
  "system_sweep",
  "command",
  "agent_tick",
  "flow_run",
  "run_schedule",
  "webhook_delivery",
  "domain_event_dispatch",
  "auto_launch_triaged",
] as const;

describe("scheduler job catalog", () => {
  it("describes every scheduler job kind exactly once", () => {
    expect(ALL_SCHEDULER_JOB_KINDS).toEqual(ALL_JOB_KINDS);
    expect(FILTERABLE_SCHEDULER_JOB_KINDS).toEqual(ALL_JOB_KINDS);
    expect(Object.keys(SCHEDULER_JOB_KIND_CATALOG)).toEqual(ALL_JOB_KINDS);
  });

  it("keeps creatable job kinds aligned with the admin create schema", () => {
    expect(CREATABLE_SCHEDULER_JOB_KINDS).toEqual([
      "system_sweep",
      "command",
      "flow_run",
      "webhook_delivery",
    ]);

    expect(isCreatableSchedulerJobKind("command")).toBe(true);
    expect(isCreatableSchedulerJobKind("webhook_delivery")).toBe(true);
    expect(isCreatableSchedulerJobKind("agent_tick")).toBe(false);
    expect(isCreatableSchedulerJobKind("run_schedule")).toBe(false);
    expect(isCreatableSchedulerJobKind("domain_event_dispatch")).toBe(false);
    expect(isCreatableSchedulerJobKind("auto_launch_triaged")).toBe(false);
  });

  it("classifies seeded singleton rows separately from creatable kinds", () => {
    expect(isSystemManagedSchedulerJobKind("agent_tick")).toBe(true);
    expect(isSystemManagedSchedulerJobKind("run_schedule")).toBe(true);
    expect(isSystemManagedSchedulerJobKind("domain_event_dispatch")).toBe(true);
    expect(isSystemManagedSchedulerJobKind("auto_launch_triaged")).toBe(true);
    expect(isSystemManagedSchedulerJobKind("command")).toBe(false);

    expect(
      isSeededSingletonSchedulerJob({
        id: "system_sweep.default",
        jobKind: "system_sweep",
      }),
    ).toBe(true);
    expect(
      isSeededSingletonSchedulerJob({
        id: "run_schedule.dispatcher",
        jobKind: "run_schedule",
      }),
    ).toBe(true);
    expect(
      isSeededSingletonSchedulerJob({
        id: "webhook_delivery.default",
        jobKind: "webhook_delivery",
      }),
    ).toBe(true);
    expect(
      isSeededSingletonSchedulerJob({
        id: "domain_event_dispatch.default",
        jobKind: "domain_event_dispatch",
      }),
    ).toBe(true);
    expect(
      isSeededSingletonSchedulerJob({
        id: "agent_tick.dispatcher",
        jobKind: "agent_tick",
      }),
    ).toBe(true);
    expect(
      isSeededSingletonSchedulerJob({
        id: "auto_launch_triaged.default",
        jobKind: "auto_launch_triaged",
      }),
    ).toBe(true);
    expect(
      isSeededSingletonSchedulerJob({
        id: "custom-healthcheck",
        jobKind: "command",
      }),
    ).toBe(false);
  });
});
