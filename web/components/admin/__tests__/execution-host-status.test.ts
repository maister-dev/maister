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
      strandedAgentTurns: 0,
      strandedAgentTurnRows: [],
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

type StreamRow = (typeof lag.streams)[number];

function streamRow(
  rowId: string,
  telemetry: Partial<NonNullable<StreamRow["hostTelemetry"]>> | null,
): StreamRow {
  return {
    streamRowId: rowId,
    executionHostId: "host-1",
    hostKey: "eh_local",
    displayName: "Local",
    readiness: "ready",
    readinessReason: null,
    hostLastSeenAt: sampledAt,
    hostBootId: "boot-1",
    streamId: rowId,
    streamState: "active",
    lastReceivedSequence: "9",
    lastContiguousSequence: "9",
    lastAckConfirmedSequence: "9",
    streamLastSeenAt: sampledAt,
    lastError: null,
    claimOwner: null,
    claimExpiresAt: null,
    hostTelemetry:
      telemetry === null
        ? null
        : {
            streamId: rowId,
            headSequence: "900",
            unacknowledgedCount: 0,
            retainedCount: 900,
            pressured: false,
            oldestUnacknowledgedAgeMs: null,
            subscriberPauses: null,
            closes: null,
            sampledAt,
            bootId: "boot-1",
            ...telemetry,
          },
    hostTelemetryStatus: telemetry === null ? "unavailable" : "available",
    hostTelemetryReason: null,
    lag: {
      hostToManager: "0",
      contiguityGap: "0",
      ackConfirmation: "0",
      diagnostics: [],
    },
  };
}

async function pressureCells(streams: readonly StreamRow[]): Promise<string[]> {
  const html = renderToStaticMarkup(
    await ExecutionHostStatus({
      status: { ...status, lag: { ...lag, streams: [...streams] } },
    }),
  );

  return streams.map((stream) => {
    const row = html
      .split("<tr")
      .find((candidate) => candidate.includes(`>${stream.streamId}<`))!;
    const start = row.indexOf('data-testid="stream-pressure-cell"');

    return row.slice(start, row.indexOf("</td>", start));
  });
}

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

  it("shows the host's subscriber pauses and closes by reason, or missing", async () => {
    const stream = (
      subscriberPauses: number | null,
      closes: {
        disconnect: number;
        protocol: number;
        floor: number;
        shutdown: number;
      } | null,
    ) => ({
      streamRowId: `row-${String(subscriberPauses)}`,
      executionHostId: "host-1",
      hostKey: "eh_local",
      displayName: "Local",
      readiness: "ready",
      readinessReason: null,
      hostLastSeenAt: sampledAt,
      hostBootId: "boot-1",
      streamId: "stream-1",
      streamState: "active" as const,
      lastReceivedSequence: "9",
      lastContiguousSequence: "9",
      lastAckConfirmedSequence: "9",
      streamLastSeenAt: sampledAt,
      lastError: null,
      claimOwner: null,
      claimExpiresAt: null,
      hostTelemetry: {
        streamId: "stream-1",
        headSequence: "9",
        unacknowledgedCount: 0,
        retainedCount: 10,
        pressured: false,
        oldestUnacknowledgedAgeMs: null,
        subscriberPauses,
        closes,
        sampledAt,
        bootId: "boot-1",
      },
      hostTelemetryStatus: "available" as const,
      hostTelemetryReason: null,
      lag: {
        hostToManager: "0",
        contiguityGap: "0",
        ackConfirmation: "0",
        diagnostics: [],
      },
    });
    const html = renderToStaticMarkup(
      await ExecutionHostStatus({
        status: {
          ...status,
          lag: {
            ...lag,
            streams: [
              stream(4, { disconnect: 2, protocol: 1, floor: 0, shutdown: 3 }),
              stream(null, null),
            ],
          },
        },
      }),
    );

    expect(html).toContain("streams.pauses: 4");
    expect(html).toContain(
      "streams.closes: closeReason.disconnect 2 · closeReason.protocol 1 · closeReason.floor 0 · closeReason.shutdown 3",
    );
    expect(html).toContain('title="streams.closesLegend"');
    // An older host reports neither: the cells read as missing, never zero.
    expect(html).toContain("streams.pauses: missing");
    expect(html).toContain("streams.closes: missing");
  });

  it("ADR-183: renders the pressure episode with a warning tone, not yes/no", async () => {
    const telemetry = (
      pressure: null | {
        since: string;
        unacknowledgedCountAtStart: number;
        unacknowledgedBytesAtStart: number;
        episodes: number;
      },
      rowId: string,
    ) =>
      streamRow(rowId, {
        unacknowledgedCount: pressure ? 700 : 0,
        pressured: pressure !== null,
        pressure,
      });
    const html = renderToStaticMarkup(
      await ExecutionHostStatus({
        status: {
          ...status,
          lag: {
            ...lag,
            streams: [
              telemetry(
                {
                  since: "2026-09-22T09:58:30.000Z",
                  unacknowledgedCountAtStart: 640,
                  unacknowledgedBytesAtStart: 65_536,
                  episodes: 2,
                },
                "stream-pressured",
              ),
              telemetry(null, "stream-clear"),
            ],
          },
        },
      }),
    );
    const cell = html.slice(html.indexOf('data-testid="stream-pressure"'));

    expect(cell).toContain("▲");
    expect(cell).toContain("pressure.active");
    expect(cell).toMatch(/pressure\.since\(value=[^)]+\)/);
    // 90 s between the episode start and the sample.
    expect(cell).toContain("pressure.duration(value=1m 30s)");
    expect(cell).toContain("pressure.unackedAtStart(count=640)");
    expect(cell).toContain("pressure.episodes(count=2)");
    expect(html).toContain("pressure.clear");
    expect(html).not.toMatch(/>(yes|no)</);
  });

  // ADR-183 amendment 2026-09-28: the cell shows what the admission fence
  // follows. A host can refuse new work at the retained, physical or control
  // limit without being pressured — "not pressured" hid exactly that.
  it("names the limit a host refuses new work at, pressured or not", async () => {
    const [retained, unacked] = await pressureCells([
      streamRow("s-retained", { newWorkRefusedBy: "retained" }),
      streamRow("s-unacked", {
        pressured: true,
        newWorkRefusedBy: "unacknowledged",
        pressure: {
          since: "2026-09-22T09:59:00.000Z",
          unacknowledgedCountAtStart: 640,
          unacknowledgedBytesAtStart: 65_536,
          episodes: 0,
        },
      }),
    ]);

    expect(retained).toContain(
      "pressure.refusingNewWork(limit=pressure.limit.retained)",
    );
    expect(retained).not.toContain("pressure.clear");
    expect(unacked).toContain(
      "pressure.refusingNewWork(limit=pressure.limit.unacknowledged)",
    );
    expect(unacked).toContain("pressure.active");
    expect(unacked).toContain("pressure.unackedAtStart(count=640)");
  });

  // U6b: the cell's other branches.
  it("says missing without telemetry, and for a pressured host with no episode", async () => {
    const [absent, noEpisode, admitting] = await pressureCells([
      streamRow("s-absent", null),
      streamRow("s-no-episode", { pressured: true, pressure: null }),
      streamRow("s-admitting", { newWorkRefusedBy: null }),
    ]);

    expect(absent).toMatch(/>missing$/);
    expect(noEpisode).toContain("pressure.active");
    expect(noEpisode).not.toContain("pressure.since");
    expect(noEpisode).toContain(">missing<");
    expect(noEpisode).not.toContain("pressure.refusingNewWork");
    expect(admitting).toContain("pressure.clear");
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

  it("D-M3: lists stranded agent messages with a link to each run, or says there are none", async () => {
    const empty = renderToStaticMarkup(await ExecutionHostStatus({ status }));

    expect(empty).toContain("commands.strandedTitle");
    expect(empty).toContain("commands.strandedEmpty");
    const html = renderToStaticMarkup(
      await ExecutionHostStatus({
        status: {
          ...status,
          lag: {
            ...lag,
            commands: {
              ...lag.commands,
              strandedAgentTurns: 3,
              strandedAgentTurnRows: [
                {
                  runId: "run-stranded",
                  runStatus: "NeedsInputIdle",
                  turnId: "turn-1",
                  ordinal: 4,
                  ageMs: 660_000,
                  resumeRequestedAt: null,
                },
              ],
            },
          },
        },
      }),
    );

    expect(html).toContain('href="/runs/run-stranded"');
    expect(html).toContain("NeedsInputIdle");
    expect(html).toContain("commands.strandedRow(ordinal=4,age=11m)");
    expect(html).not.toContain("commands.strandedEmpty");
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
