import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AutomationsPanel } from "@/components/automations/automations-panel";

const labels = {
  all: "All",
  agent: "Agent bindings",
  attention: "Needs attention",
  cancel: "Cancel",
  cancelConfirm: "Cancel this scheduled run?",
  cancelEdit: "Discard",
  disambiguation: "DST choice",
  edit: "Edit",
  earlier: "Earlier offset",
  empty: "No automations",
  error: "Could not update",
  errorLabels: { PRECONDITION: "Needs attention" },
  manageAgent: "Manage agent automation",
  later: "Later offset",
  lateByOne: "Late by __MINUTES__ min",
  lateByOther: "Late by __MINUTES__ min",
  runNow: "Run now",
  oneTime: "One-time launches",
  outcomeLabels: { created: "Created" },
  recurring: "Recurring schedules",
  save: "Save",
  saving: "Saving",
  scheduledLocalTime: "Local date and time",
  stateLabels: { Scheduled: "Scheduled", Enabled: "Enabled" },
  timezone: "IANA timezone",
  title: "Automations",
  viewRun: "View Run",
};

describe("AutomationsPanel", () => {
  it("offers Run now and Cancel only for mutable one-time task launches", () => {
    const html = renderToStaticMarkup(
      createElement(
        AutomationsPanel,
        {
          canManage: true,
          initialRows: [
          {
            id: "intent-1",
            type: "one_time_task_launch",
            name: "Schedule APP-1",
            target: "Patch dependency",
            trigger: "2026-12-01T10:00",
            timezone: "UTC",
            nextActionAt: "2026-12-01T10:00:00.000Z",
            state: "Scheduled",
            latestOutcome: "created",
            errorCode: null,
            errorMessage: null,
            lateByMs: 61_000,
            resultingRun: null,
            detailHref: "/api/projects/demo/automations/one_time_task_launch/intent-1",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "binding-1",
            type: "agent_event",
            name: "Reviewer",
            target: "Reviewer",
            trigger: "task.created",
            timezone: null,
            nextActionAt: null,
            state: "Enabled",
            latestOutcome: null,
            errorCode: "PRECONDITION",
            errorMessage: "unsafe path /private/worktree",
            lateByMs: null,
            resultingRun: null,
            detailHref: "/api/projects/demo/automations/agent_event/binding-1",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          ],
          labels,
          slug: "demo",
        },
        createElement("div", null, "Recurring schedules"),
      ),
    );

    expect(html).toContain("Run now");
    expect(html).toContain("Cancel");
    expect(html).toContain("Manage agent automation");
    expect(html).toContain("Recurring schedules");
    expect(html).toContain("One-time launches");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Late by 2 min");
    expect(html).not.toContain("/private/worktree");
  });
});
