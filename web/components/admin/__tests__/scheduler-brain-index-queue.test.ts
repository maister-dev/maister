import type {
  BrainIndexQueueViewData,
  SchedulerClockStatus,
} from "@/types/scheduler";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { SchedulerBrainIndexQueue } from "@/components/admin/scheduler-brain-index-queue";

function clock(over: Partial<SchedulerClockStatus> = {}): SchedulerClockStatus {
  return {
    cronTokenConfigured: false,
    driver: "missing_tick",
    fallbackTimerEnabled: false,
    tickIntervalSeconds: 60,
    tickPath: "/api/cron/tick",
    ...over,
  };
}

function queue(
  over: Partial<BrainIndexQueueViewData> = {},
): BrainIndexQueueViewData {
  return {
    rows: [
      {
        createdAt: "2026-07-05T09:00:00.000Z",
        id: "job-1",
        progress: 12,
        projectId: "project-1",
        projectName: "mAIster",
        projectSlug: "maister",
        reason: "manual",
        resumableCursor: null,
        sourceId: "source-1",
        sourceLastError: null,
        sourceLastIndexedAt: "2026-07-04T09:00:00.000Z",
        sourcePath: "docs/**/*.md",
        status: "queued",
      },
    ],
    schemaApplied: true,
    summary: { completed: 4, failed: 0, queued: 1, running: 0, total: 5 },
    ...over,
  };
}

describe("SchedulerBrainIndexQueue", () => {
  it("renders clock diagnostics and links queued Brain jobs to the project", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerBrainIndexQueue, {
        clock: clock({ cronTokenConfigured: true, driver: "external_tick" }),
        queue: queue(),
      }),
    );

    expect(markup).toContain("brainQueue.clock.driver.external_tick");
    expect(markup).toContain("/api/cron/tick");
    expect(markup).toContain("docs/**/*.md");
    expect(markup).toContain("job-1");
    expect(markup).toContain('href="/projects/maister?tab=brain"');
  });

  it("renders a diagnostic row when Brain schema is not applied", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerBrainIndexQueue, {
        clock: clock(),
        queue: queue({
          rows: [],
          schemaApplied: false,
          summary: { completed: 0, failed: 0, queued: 0, running: 0, total: 0 },
        }),
      }),
    );

    expect(markup).toContain("brainQueue.schemaMissing");
    expect(markup).toContain("brainQueue.clock.driver.missing_tick");
  });
});
