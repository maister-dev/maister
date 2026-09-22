import type { SchedulerClockStatus } from "@/types/scheduler";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { SchedulerClockCard } from "@/components/admin/scheduler-clock-card";

const clock: SchedulerClockStatus = {
  cronTokenConfigured: false,
  driver: "fallback_timer",
  fallbackTimerEnabled: true,
  tickIntervalSeconds: 60,
  tickPath: "/api/cron/tick",
  health: {
    processId: 42,
    observedAt: "2026-09-22T10:00:00.000Z",
    activeCount: 0,
    lastStartedAt: "2026-09-22T09:59:00.000Z",
    lastFinishedAt: "2026-09-22T09:59:01.000Z",
    lastDurationMs: 1000,
    lastOutcome: "partial",
    skippedOverlapTotal: 2,
    skippedOverlapCurrentStreak: 0,
    skippedOverlapLastStreak: 2,
  },
};

describe("SchedulerClockCard", () => {
  it("keeps both core jobs visible when the general scheduler list is unrelated", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerClockCard, {
        clock,
        coreJobs: [
          {
            id: "system_sweep.default",
            nextRunAt: "2026-09-22T10:01:00.000Z",
            disabledAt: null,
            lastStartedAt: "2026-09-22T09:59:00.000Z",
            lastFinishedAt: "2026-09-22T09:59:01.000Z",
            lastStatus: "Failed",
            lastErrorCode: "SYSTEM_SWEEP_FAILED",
          },
        ],
      }),
    );

    expect(markup).toContain("system_sweep.default");
    expect(markup).toContain("domain_event_dispatch.default");
    expect(markup).toContain("outcomes.partial");
    expect(markup).toContain("missingJob");
    expect(markup).toContain("SYSTEM_SWEEP_FAILED");
    expect(markup).toContain("42");
  });
});
