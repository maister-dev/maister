import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SchedulerScheduledLaunchesOverview } from "@/components/admin/scheduler-scheduled-launches-overview";

const labels = {
  attempt: "attempt",
  empty: "No scheduled launches",
  subtitle: "Read-only diagnostics",
  title: "One-time scheduled launches",
};

describe("SchedulerScheduledLaunchesOverview", () => {
  it("deep-links an operator to the owning project automation surface without exposing reservation data", () => {
    const html = renderToStaticMarkup(
      createElement(SchedulerScheduledLaunchesOverview, {
        labels,
        launches: [
          {
            scheduledLaunchId: "intent-1",
            projectSlug: "demo",
            projectName: "Demo",
            taskKey: "D",
            taskNumber: 42,
            taskTitle: "Scheduled task",
            state: "RetryWaiting",
            nextAttemptAt: "2026-06-01T10:16:00.000Z",
            attemptCount: 1,
            latestOutcome: "retry_scheduled",
            errorCode: "EXECUTOR_UNAVAILABLE",
          },
        ],
      }),
    );

    expect(html).toContain('href="/projects/demo?tab=automations"');
    expect(html).toContain("RetryWaiting");
    expect(html).not.toContain("worktree");
    expect(html).not.toContain("branch");
  });

  it("renders an explicit empty diagnostic state", () => {
    const html = renderToStaticMarkup(
      createElement(SchedulerScheduledLaunchesOverview, { labels, launches: [] }),
    );

    expect(html).toContain("No scheduled launches");
  });
});
