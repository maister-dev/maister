import type { ScheduleDTO } from "@/lib/run-schedules/queries";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import {
  buildSchedulePatch,
  ScheduleEditModal,
  type ScheduleDraft,
} from "@/components/schedules/schedule-edit-modal";

function schedule(over: Partial<ScheduleDTO> = {}): ScheduleDTO {
  return {
    id: "sched-1",
    name: "Nightly bugfix sweep",
    taskId: "task-1",
    taskTitle: "Fix flaky tests",
    cronExpr: "0 3 * * *",
    timezone: "Europe/Berlin",
    overlapPolicy: "skip",
    runnerId: "runner-a",
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

function draft(over: Partial<ScheduleDraft> = {}): ScheduleDraft {
  return {
    name: "Nightly bugfix sweep",
    cronExpr: "0 3 * * *",
    timezone: "Europe/Berlin",
    overlapPolicy: "skip",
    runnerId: "runner-a",
    enabled: true,
    ...over,
  };
}

describe("ScheduleEditModal", () => {
  it("renders create mode with task options and field labels", () => {
    const markup = renderToStaticMarkup(
      createElement(ScheduleEditModal, {
        schedule: null,
        slug: "proj",
        tasks: [
          { id: "task-1", title: "Fix flaky tests", status: "Backlog" },
          { id: "task-2", title: "Bump deps", status: "InFlight" },
        ],
        onClose: () => {},
        onSaved: () => {},
      }),
    );

    expect(markup).toContain("modal.createTitle");
    expect(markup).toContain("modal.nameLabel");
    expect(markup).toContain("modal.cronLabel");
    expect(markup).toContain("modal.timezoneLabel");
    expect(markup).toContain("modal.overlapLabel");
    expect(markup).toContain("modal.runnerLabel");
    expect(markup).toContain("modal.enabledLabel");
    expect(markup).toContain("Fix flaky tests (Backlog)");
    expect(markup).toContain("Bump deps (InFlight)");
    expect(markup).toContain("modal.overlapHint.skip");
    expect(markup).not.toContain("modal.delete");
  });

  it("hides terminal (Done/Abandoned) tasks from the create picker", () => {
    const markup = renderToStaticMarkup(
      createElement(ScheduleEditModal, {
        schedule: null,
        slug: "proj",
        tasks: [
          { id: "task-1", title: "Fix flaky tests", status: "Backlog" },
          { id: "task-2", title: "Shipped feature", status: "Done" },
          { id: "task-3", title: "Dropped idea", status: "Abandoned" },
        ],
        onClose: () => {},
        onSaved: () => {},
      }),
    );

    expect(markup).toContain("Fix flaky tests (Backlog)");
    expect(markup).not.toContain("Shipped feature");
    expect(markup).not.toContain("Dropped idea");
  });

  it("renders edit mode with the fixed task and delete affordance", () => {
    const markup = renderToStaticMarkup(
      createElement(ScheduleEditModal, {
        schedule: schedule(),
        slug: "proj",
        tasks: [],
        onClose: () => {},
        onSaved: () => {},
      }),
    );

    expect(markup).toContain("modal.editTitle");
    expect(markup).toContain("Fix flaky tests");
    expect(markup).toContain("modal.delete");
  });
});

describe("buildSchedulePatch", () => {
  it("includes only dirty fields", () => {
    const patch = buildSchedulePatch(
      schedule(),
      draft({ cronExpr: "*/30 * * * *", enabled: false }),
    );

    expect(patch).toEqual({ cronExpr: "*/30 * * * *", enabled: false });
  });

  it("includes an explicit runnerId null when cleared", () => {
    const patch = buildSchedulePatch(schedule(), draft({ runnerId: null }));

    expect(patch).toEqual({ runnerId: null });
    expect("runnerId" in patch).toBe(true);
  });

  it("returns an empty patch when nothing changed", () => {
    expect(buildSchedulePatch(schedule(), draft())).toEqual({});
  });
});
