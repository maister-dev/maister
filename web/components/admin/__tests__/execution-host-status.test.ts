import type { AdminExecutionHostStatus } from "@/lib/execution-host/admin-status";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl/server", () => ({
  getLocale: async () => "ru-RU",
  getTranslations: async () => (key: string) => key,
}));

import { ExecutionHostStatus } from "@/components/admin/execution-host-status";

const sampledAt = "2026-09-22T10:00:00.000Z";

const status: AdminExecutionHostStatus = {
  sampledAt,
  hosts: [
    {
      id: "host-1",
      hostKey: "eh_local",
      displayName: "Local",
      kind: "local",
      readiness: "ready",
      readinessReason: null,
      bootId: "boot-1",
      lastSeenAt: sampledAt,
      version: "1.0.0",
      capabilities: {},
      registeredAt: sampledAt,
      retiredAt: null,
    },
  ],
  lag: {
    sampledAt,
    streams: [],
    consumers: {
      eligiblePopulation: 0,
      totalConsumers: 0,
      displayed: 0,
      truncated: 0,
      maximumBacklog: "0",
      diagnosticCount: 0,
      byHost: [],
      top: [],
      diagnostics: [],
    },
    poison: { total: 0, displayed: 0, nextAfter: null, rows: [] },
    commands: {
      total: 1,
      queued: 0,
      delivering: 0,
      accepted: 1,
      acceptedWithoutTimestamp: 0,
      oldestAcceptedAt: sampledAt,
      oldestAcceptedAgeMs: 90_000,
      hostSpan: [
        {
          executionHostId: "host-1",
          hostSpanUnconfirmed: 3,
          hostSpanSettled1h: 7,
          postHocConflicts: 1,
        },
      ],
    },
  },
  latestSweep: null,
  workers: {},
  schedulerClock: {
    driver: "fallback_timer",
    fallbackTimerEnabled: true,
    cronTokenConfigured: false,
    tickIntervalSeconds: 60,
    tickPath: "/api/cron/tick",
    health: {
      processId: 1,
      observedAt: sampledAt,
      activeCount: 0,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastDurationMs: null,
      lastOutcome: null,
      skippedOverlapTotal: 0,
      skippedOverlapCurrentStreak: 0,
      skippedOverlapLastStreak: 0,
    },
  },
  poisonCursor: null,
};

describe("ExecutionHostStatus", () => {
  it("renders explicit legends, compact durations, and locale-stable UTC dates", async () => {
    const markup = renderToStaticMarkup(await ExecutionHostStatus({ status }));
    const expectedDate = new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: "UTC",
    }).format(new Date(sampledAt));

    expect(markup).toContain(expectedDate);
    expect(markup).toContain("1m 30s");
    expect(markup).toContain("streams.watermarkLegend");
    expect(markup).toContain("streams.lagLegend");
    expect(markup).not.toContain("90s");
  });

  it("renders each host's host-span settlement counts as numbers", async () => {
    const html = renderToStaticMarkup(await ExecutionHostStatus({ status }));

    expect(html).toContain("commands.hostSpan");
    for (const [label, value] of [
      ["fields.hostSpanUnconfirmed", "3"],
      ["fields.hostSpanSettled1h", "7"],
      ["fields.postHocConflicts", "1"],
    ])
      expect(html).toMatch(
        new RegExp(`${label.replace(".", "\\.")}</dt><dd[^>]*>${value}</dd>`),
      );
  });

  it("D6: renders per-panel unavailability instead of failing the page", async () => {
    const markup = renderToStaticMarkup(
      await ExecutionHostStatus({
        status: {
          ...status,
          lag: { unavailable: true },
          latestSweep: { unavailable: true },
        },
      }),
    );

    expect(markup).toContain("panelUnavailable");
    // The host row and the clock survive the collector's failure.
    expect(markup).toContain("eh_local");
    expect(markup).toContain("driver.fallback_timer");
  });

  it("localizes every status token rather than printing the enum member", async () => {
    const markup = renderToStaticMarkup(await ExecutionHostStatus({ status }));

    expect(markup).toContain("readiness.ready");
    expect(markup).toContain("driver.fallback_timer");
    expect(markup).not.toMatch(/>\s*ready\s*</);
    expect(markup).not.toMatch(/>\s*fallback_timer\s*</);
  });
});
