import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import {
  SchedulerRunSchedulesOverview,
  type SchedulerRunScheduleOverviewRow,
} from "@/components/admin/scheduler-run-schedules-overview";

function schedule(
  over: Partial<SchedulerRunScheduleOverviewRow> = {},
): SchedulerRunScheduleOverviewRow {
  return {
    scheduleId: "sched-1",
    scheduleName: "Nightly bugfix sweep",
    projectId: "project-1",
    projectSlug: "maister",
    projectName: "mAIster",
    taskId: "task-1",
    taskNumber: 42,
    taskTitle: "Fix flaky tests",
    taskStatus: "InFlight",
    cronExpr: "0 3 * * *",
    timezone: "Europe/Berlin",
    overlapPolicy: "skip",
    runnerId: null,
    enabled: true,
    nextFireAt: "2026-06-11T01:00:00.000Z",
    queueOnePending: false,
    queuedFireAt: null,
    lastFiredAt: "2026-06-10T01:00:00.000Z",
    lastFireOutcome: "launched",
    lastFireError: null,
    lastRunId: "run-9",
    lastRunStatus: "Running",
    ...over,
  };
}

describe("SchedulerRunSchedulesOverview", () => {
  it("links the last run when a schedule has one", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerRunSchedulesOverview, {
        schedules: [schedule()],
      }),
    );

    expect(markup).toContain("Nightly bugfix sweep");
    expect(markup).toContain("Running");
    expect(markup).toContain('href="/runs/run-9"');
  });

  it("keeps last-run status as plain text when the run id is absent", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerRunSchedulesOverview, {
        schedules: [schedule({ lastRunId: null })],
      }),
    );

    expect(markup).toContain("Running");
    expect(markup).not.toContain('href="/runs/run-9"');
  });
});
