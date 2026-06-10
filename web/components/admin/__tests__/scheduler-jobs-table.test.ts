import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/admin/scheduler",
}));

import {
  SchedulerJobsTable,
  type SchedulerJobRow,
} from "@/components/admin/scheduler-jobs-table";

function job(over: Partial<SchedulerJobRow> = {}): SchedulerJobRow {
  return {
    id: "system_sweep.default",
    projectId: null,
    jobKind: "system_sweep",
    target: {},
    cadenceIntervalSeconds: 60,
    nextRunAt: "2026-06-05T10:00:00.000Z",
    lastFiredAt: null,
    disabledAt: null,
    consecutiveFailures: 0,
    maxFailures: 3,
    lastStatus: null,
    lastFinishedAt: null,
    lastErrorCode: null,
    ...over,
  };
}

describe("SchedulerJobsTable", () => {
  it("renders a row per job with cadence and failure counts", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerJobsTable, {
        filters: { jobKind: "all", state: "all" },
        jobs: [
          job(),
          job({ id: "ping-1", jobKind: "command", maxFailures: 5 }),
        ],
      }),
    );

    expect(markup).toContain("system_sweep.default");
    expect(markup).toContain("ping-1");
    expect(markup).toContain("0/3");
    expect(markup).toContain("0/5");
  });

  it("renders the empty state when there are no jobs", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerJobsTable, {
        filters: { jobKind: "all", state: "all" },
        jobs: [],
      }),
    );

    expect(markup).toContain("noResults");
  });

  it("offers run_schedule in the kind filter", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerJobsTable, {
        filters: { jobKind: "all", state: "all" },
        jobs: [],
      }),
    );

    expect(markup).toContain("kind.run_schedule");
  });
});
