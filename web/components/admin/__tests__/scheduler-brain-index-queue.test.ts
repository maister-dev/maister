import type { BrainIndexQueueViewData } from "@/types/scheduler";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { SchedulerBrainIndexQueue } from "@/components/admin/scheduler-brain-index-queue";

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
  it("links queued Brain jobs to the project without clock diagnostics", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerBrainIndexQueue, {
        queue: queue(),
      }),
    );

    expect(markup).not.toContain("brainQueue.clock");
    expect(markup).toContain("docs/**/*.md");
    expect(markup).toContain("job-1");
    expect(markup).toContain('href="/projects/maister?tab=brain"');
  });

  it("renders a diagnostic row when Brain schema is not applied", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerBrainIndexQueue, {
        queue: queue({
          rows: [],
          schemaApplied: false,
          summary: { completed: 0, failed: 0, queued: 0, running: 0, total: 0 },
        }),
      }),
    );

    expect(markup).toContain("brainQueue.schemaMissing");
  });
});
