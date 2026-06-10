import type { ScheduleDTO } from "@/lib/run-schedules/queries";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { SchedulesTable } from "@/components/schedules/schedules-table";

function schedule(over: Partial<ScheduleDTO> = {}): ScheduleDTO {
  return {
    id: "sched-1",
    name: "Nightly bugfix sweep",
    taskId: "task-1",
    taskTitle: "Fix flaky tests",
    cronExpr: "0 3 * * *",
    timezone: "Europe/Berlin",
    overlapPolicy: "skip",
    runnerId: null,
    enabled: true,
    nextFireAt: "2026-06-11T01:00:00.000Z",
    queueOnePending: false,
    queuedFireAt: null,
    lastFiredAt: null,
    lastFireOutcome: null,
    lastFireError: null,
    lastRunId: null,
    lastRunStatus: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

const noop = (): void => {};

function render(schedules: ScheduleDTO[], canManage: boolean = true): string {
  return renderToStaticMarkup(
    createElement(SchedulesTable, {
      busy: false,
      canManage,
      schedules,
      onEdit: noop,
      onToggleEnabled: noop,
      onTrigger: noop,
    }),
  );
}

describe("SchedulesTable", () => {
  it("renders a row per schedule with catch-up indicator and outcome chips", () => {
    const markup = render([
      schedule({
        queueOnePending: true,
        queuedFireAt: "2026-06-10T08:00:00.000Z",
        lastFiredAt: "2026-06-10T01:00:00.000Z",
        lastFireOutcome: "launched",
        lastRunId: "run-9",
        lastRunStatus: "Running",
      }),
      schedule({
        id: "sched-2",
        name: "Weekly dependency bump",
        cronExpr: "0 9 * * 1",
        enabled: false,
        lastFireOutcome: "launch_failed",
        lastFireError: "branch already exists",
      }),
    ]);

    expect(markup).toContain("Nightly bugfix sweep");
    expect(markup).toContain("Weekly dependency bump");
    expect(markup).toContain("Fix flaky tests");
    expect(markup).toContain("0 3 * * *");
    expect(markup).toContain("Europe/Berlin");
    expect(markup).toContain("queuedCatchUp");
    expect(markup).toContain("outcome.launched");
    expect(markup).toContain("Running");
    expect(markup).toContain("enabledBadge");
    expect(markup).toContain("pausedBadge");
    expect(markup).toContain("outcome.launch_failed");
    expect(markup).toContain("branch already exists");
  });

  it("renders the empty state when there are no schedules", () => {
    expect(render([])).toContain("empty");
  });

  it("hides mutate affordances when canManage is false", () => {
    const markup = render([schedule()], false);

    expect(markup).not.toContain("triggerNow");
    expect(markup).not.toContain("pause");
    expect(markup).not.toContain("edit");

    const managed = render([schedule()], true);

    expect(managed).toContain("triggerNow");
    expect(managed).toContain("pause");
    expect(managed).toContain("edit");
  });
});
