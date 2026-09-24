import type { AdminExecutionHostStatus } from "@/lib/execution-host/admin-status";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Echoes interpolation values so a dropped or misnamed parameter fails.
vi.mock("next-intl/server", () => ({
  getLocale: async () => "ru-RU",
  getTranslations:
    async () => (key: string, values?: Record<string, unknown>) =>
      values === undefined
        ? key
        : `${key}(${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(",")})`,
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
          hostKey: "eh_local",
          displayName: "Local",
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
const lag = status.lag as Exclude<
  AdminExecutionHostStatus["lag"],
  { unavailable: true }
>;

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

  it("renders each host's host-span counts under its own named group, with windows and help", async () => {
    const html = renderToStaticMarkup(
      await ExecutionHostStatus({
        status: {
          ...status,
          lag: {
            ...lag,
            commands: {
              ...lag.commands,
              hostSpan: [
                ...lag.commands.hostSpan,
                {
                  executionHostId: "host-2",
                  hostKey: "eh_remote",
                  displayName: "Remote",
                  hostSpanUnconfirmed: 0,
                  hostSpanSettled1h: 0,
                  postHocConflicts: 0,
                },
              ],
            },
          },
        },
      }),
    );

    for (const [id, name, key, values] of [
      ["host-1", "Local", "eh_local", ["3", "7", "1"]],
      ["host-2", "Remote", "eh_remote", ["0", "0", "0"]],
    ] as const) {
      const group = html.match(
        new RegExp(
          `<section aria-labelledby="host-span-${id}"[^>]*>(.*?)</section>`,
        ),
      )?.[1];

      expect(group, id).toBeDefined();
      // The group is named by the same identity the hosts panel shows.
      expect(group).toMatch(
        new RegExp(
          `<h3[^>]*id="host-span-${id}"[^>]*>commands\\.hostSpan\\(host=${name}\\)</h3>`,
        ),
      );
      expect(group).toContain(key);
      // A valid <dl>: each <div> holds only its <dt> and <dd>s — an explicit
      // zero is a rendered value, not an absent row.
      for (const [index, [label, period]] of [
        ["hostSpanUnconfirmed", "days=7"],
        ["hostSpanSettled1h", "hours=1"],
        ["postHocConflicts", "days=7"],
      ].entries())
        expect(group).toMatch(
          new RegExp(
            `<div[^>]*><dt[^>]*>fields\\.${label}\\(${period}\\)</dt><dd[^>]*>${values[index]}</dd><dd[^>]*>hostSpanHelp\\.${label}\\(${period}\\)</dd></div>`,
          ),
        );
    }
    expect(html).not.toMatch(/<dl[^>]*>(?:(?!<\/dl>).)*<p[\s>]/);
  });

  it("renders an explicit empty state when no host has host-span data", async () => {
    const html = renderToStaticMarkup(
      await ExecutionHostStatus({
        status: {
          ...status,
          lag: { ...lag, commands: { ...lag.commands, hostSpan: [] } },
        },
      }),
    );

    expect(html).toContain("commands.hostSpanEmpty(days=7)");
    expect(html).not.toContain("host-span-");
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
