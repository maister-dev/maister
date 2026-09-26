import { describe, expect, it } from "vitest";

import {
  boundExecutionObservability,
  createExecutionObservability,
  parseExecutionObservability,
  reduceLagObservation,
  type ExecutionObservabilitySummary,
  type LagObservationSample,
} from "@/lib/execution-host/events/lag-observation";

const identity = {
  executionHostId: "host-1",
  streamId: "stream-1",
  bootId: "boot-1",
} as const;

function sample(
  overrides: Partial<LagObservationSample> = {},
): LagObservationSample {
  return {
    attemptId: "attempt-current",
    observerId: "observer-b",
    sampledAt: "2026-09-22T12:02:00.000Z",
    quality: "complete",
    identity,
    streamState: "active",
    watermarks: { received: "200", contiguous: "200", acknowledged: "200" },
    hostBacklog: {
      status: "available",
      unacknowledgedCount: 101,
      oldestUnacknowledgedAgeMs: 120_000,
    },
    projectionBacklog: { status: "available", maximumBacklog: "0" },
    ...overrides,
  };
}

function firstAboveThreshold(): ReturnType<typeof reduceLagObservation> {
  return reduceLagObservation({
    sample: sample({
      attemptId: "attempt-1",
      observerId: "observer-a",
      sampledAt: "2026-09-22T12:00:00.000Z",
      watermarks: { received: "100", contiguous: "100", acknowledged: "100" },
    }),
    previous: null,
    lagAgeMs: 120_000,
  });
}

describe("reduceLagObservation", () => {
  it("opens once at progressing streak three and recovers only from a complete clear sample", () => {
    const first = firstAboveThreshold();

    expect(first).toMatchObject({
      verdict: "observing",
      streak: 0,
      transition: null,
    });

    const second = reduceLagObservation({
      sample: sample({ attemptId: "attempt-2" }),
      previous: first,
      lagAgeMs: 120_000,
    });
    const third = reduceLagObservation({
      sample: sample({
        attemptId: "attempt-3",
        sampledAt: "2026-09-22T12:03:00.000Z",
        watermarks: { received: "201", contiguous: "201", acknowledged: "201" },
      }),
      previous: second,
      lagAgeMs: 120_000,
    });
    const fourth = reduceLagObservation({
      sample: sample({
        attemptId: "attempt-4",
        sampledAt: "2026-09-22T12:04:00.000Z",
        watermarks: { received: "202", contiguous: "202", acknowledged: "202" },
      }),
      previous: third,
      lagAgeMs: 120_000,
    });

    expect(second).toMatchObject({ streak: 1, verdict: "observing" });
    expect(third).toMatchObject({ streak: 2, verdict: "observing" });
    expect(fourth).toMatchObject({
      streak: 3,
      verdict: "lagging",
      incidentOpen: true,
      transition: "lagging",
    });

    const stillOpen = reduceLagObservation({
      sample: sample({
        attemptId: "attempt-5",
        sampledAt: "2026-09-22T12:05:00.000Z",
        watermarks: { received: "203", contiguous: "203", acknowledged: "203" },
      }),
      previous: fourth,
      lagAgeMs: 120_000,
    });
    const recovered = reduceLagObservation({
      sample: sample({
        attemptId: "attempt-6",
        sampledAt: "2026-09-22T12:06:00.000Z",
        watermarks: { received: "204", contiguous: "204", acknowledged: "204" },
        hostBacklog: {
          status: "available",
          unacknowledgedCount: 100,
          oldestUnacknowledgedAgeMs: 240_000,
        },
      }),
      previous: stillOpen,
      lagAgeMs: 120_000,
    });

    expect(stillOpen.transition).toBeNull();
    expect(recovered).toMatchObject({
      verdict: "clear",
      streak: 0,
      incidentOpen: false,
      transition: "recovered",
    });
  });

  // NOT a duplicate of `lag.test.ts`'s boundary case: that one pins the
  // PREDICATE (eligible / not eligible), this one pins what the REDUCER does
  // at the same numbers — 100 is `clear` rather than merely "not lagging",
  // 101 too young stays `observing` WITH the above-threshold start preserved,
  // and a stale gap is `unknown`. Deleting either loses real coverage.
  it("honors exact backlog, age and freshness boundaries", () => {
    const first = firstAboveThreshold();
    const atThreshold = reduceLagObservation({
      sample: sample({
        hostBacklog: {
          status: "available",
          unacknowledgedCount: 100,
          oldestUnacknowledgedAgeMs: 120_000,
        },
      }),
      previous: first,
      lagAgeMs: 120_000,
    });
    const belowAge = reduceLagObservation({
      sample: sample({
        hostBacklog: {
          status: "available",
          unacknowledgedCount: 101,
          oldestUnacknowledgedAgeMs: 119_999,
        },
      }),
      previous: first,
      lagAgeMs: 120_000,
    });
    const stale = reduceLagObservation({
      sample: sample({ sampledAt: "2026-09-22T12:02:00.001Z" }),
      previous: first,
      lagAgeMs: 120_000,
    });

    expect(atThreshold.verdict).toBe("clear");
    expect(belowAge).toMatchObject({ verdict: "observing", streak: 0 });
    expect(stale).toMatchObject({ verdict: "unknown", streak: 0 });
  });

  it("requires manager watermark progress and never treats duplicate last-seen activity as progress", () => {
    const previous = firstAboveThreshold();
    const next = reduceLagObservation({
      sample: sample({
        watermarks: { received: "100", contiguous: "100", acknowledged: "100" },
      }),
      previous,
      lagAgeMs: 120_000,
    });

    expect(next).toMatchObject({ verdict: "not_advancing", streak: 0 });
  });

  it("preserves an open incident across incomplete samples but resets without recovery on identity loss", () => {
    const open = {
      ...firstAboveThreshold(),
      incidentOpen: true,
      verdict: "lagging" as const,
    };
    const unavailable = reduceLagObservation({
      sample: sample({ quality: "partial", identity: null }),
      previous: open,
      lagAgeMs: 120_000,
    });
    const replaced = reduceLagObservation({
      sample: sample({ identity: { ...identity, bootId: "boot-2" } }),
      previous: open,
      lagAgeMs: 120_000,
    });
    const lost = reduceLagObservation({
      sample: sample({ streamState: "lost" }),
      previous: open,
      lagAgeMs: 120_000,
    });

    expect(unavailable).toMatchObject({
      verdict: "unknown",
      incidentOpen: true,
      identity,
      transition: null,
    });
    expect(replaced).toMatchObject({
      verdict: "reset",
      incidentOpen: false,
      transition: "reset",
    });
    expect(lost).toMatchObject({
      verdict: "inactive",
      incidentOpen: false,
      transition: "reset",
    });
  });

  it("derives freshness from the configured scheduler cadence", () => {
    const previous = firstAboveThreshold();
    const withinCadence = reduceLagObservation({
      sample: sample({ sampledAt: "2026-09-22T12:10:00.000Z" }),
      previous,
      lagAgeMs: 120_000,
      maxSampleGapMs: 600_000,
    });
    const beyondCadence = reduceLagObservation({
      sample: sample({ sampledAt: "2026-09-22T12:10:00.001Z" }),
      previous,
      lagAgeMs: 120_000,
      maxSampleGapMs: 600_000,
    });

    expect(withinCadence.verdict).not.toBe("unknown");
    expect(beyondCadence.verdict).toBe("unknown");
  });

  it("qualifies projection-only backlog after its sustained age while optional host telemetry is unsupported", () => {
    const previous = firstAboveThreshold();
    const projection = reduceLagObservation({
      sample: sample({
        hostBacklog: { status: "unsupported" },
        projectionBacklog: { status: "available", maximumBacklog: "101" },
      }),
      previous: {
        ...previous,
        projectionOverThresholdSince: "2026-09-22T12:00:00.000Z",
      },
      lagAgeMs: 120_000,
    });

    expect(projection).toMatchObject({ verdict: "observing", streak: 1 });
  });

  it("does not recover an open incident from inconsistent projection evidence", () => {
    const open = {
      ...firstAboveThreshold(),
      incidentOpen: true,
      verdict: "lagging" as const,
    };
    const unknownProjection = reduceLagObservation({
      sample: sample({
        watermarks: { received: "201", contiguous: "201", acknowledged: "201" },
        hostBacklog: {
          status: "available",
          unacknowledgedCount: 0,
          oldestUnacknowledgedAgeMs: null,
        },
        projectionBacklog: { status: "unavailable" },
      }),
      previous: open,
      lagAgeMs: 120_000,
    });

    expect(unknownProjection).toMatchObject({
      incidentOpen: true,
      transition: null,
    });
    expect(unknownProjection.verdict).not.toBe("clear");
  });

  it("accepts only the supported bounded persisted contract", () => {
    const observation = firstAboveThreshold();
    const encoded = {
      schemaVersion: 1,
      attemptId: "attempt-1",
      observerId: "observer-a",
      sampledAt: "2026-09-22T12:00:00.000Z",
      quality: "complete",
      errors: [],
      stream: observation,
      consumers: {
        status: "available",
        total: 0,
        maximumBacklog: "0",
        top: [],
      },
      poison: { status: "available", total: 0, rows: [] },
      commands: { status: "available", total: 0, accepted: 0, impasse: 0 },
      workers: { status: "available", states: {} },
    };

    expect(parseExecutionObservability(encoded)).not.toBeNull();
    expect(
      parseExecutionObservability({ ...encoded, schemaVersion: 2 }),
    ).toBeNull();
    expect(
      parseExecutionObservability({ ...encoded, attemptId: "" }),
    ).toBeNull();
  });

  it("keeps a persisted summary that carries the host's subscriber counters", () => {
    // ADR-167 amendment 2026-09-25: a guard that did not know the two optional
    // fields would parse the whole observation to null and drop it.
    const observation = firstAboveThreshold();
    const encoded = {
      schemaVersion: 1,
      attemptId: "attempt-1",
      observerId: "observer-a",
      sampledAt: "2026-09-22T12:00:00.000Z",
      quality: "complete",
      errors: [],
      consumers: {
        status: "available",
        total: 0,
        maximumBacklog: "0",
        top: [],
      },
      poison: { status: "available", total: 0, rows: [] },
      commands: { status: "available", total: 0, accepted: 0, impasse: 0 },
      workers: { status: "available", states: {} },
    };
    const hostBacklog = {
      status: "available",
      unacknowledgedCount: 0,
      oldestUnacknowledgedAgeMs: null,
      subscriberPauses: 4,
      closes: { disconnect: 1, protocol: 0, floor: 0, shutdown: 2 },
    };

    expect(
      parseExecutionObservability({
        ...encoded,
        stream: { ...observation, hostBacklog },
      })?.stream?.hostBacklog,
    ).toEqual(hostBacklog);
    for (const broken of [
      { ...hostBacklog, subscriberPauses: -1 },
      { ...hostBacklog, closes: { disconnect: 1 } },
    ])
      expect(
        parseExecutionObservability({
          ...encoded,
          stream: { ...observation, hostBacklog: broken },
        }),
      ).toBeNull();
  });

  it("reports missing telemetry on a FIRST sample as unknown, not observing", () => {
    const unidentified = reduceLagObservation({
      sample: sample({ identity: null, quality: "partial" }),
      previous: null,
      lagAgeMs: 120_000,
    });

    expect(unidentified.verdict).toBe("unknown");
    expect(unidentified.incidentOpen).toBe(false);

    const identified = reduceLagObservation({
      sample: sample(),
      previous: null,
      lagAgeMs: 120_000,
    });

    expect(identified.verdict).toBe("observing");
  });

  it("rejects a persisted stream whose deeper members are malformed", () => {
    const observation = firstAboveThreshold();
    const encoded = {
      schemaVersion: 1,
      attemptId: "attempt-1",
      observerId: "observer-a",
      sampledAt: "2026-09-22T12:00:00.000Z",
      quality: "complete",
      errors: [],
      stream: observation,
      consumers: {
        status: "available",
        total: 0,
        maximumBacklog: "0",
        top: [],
      },
      poison: { status: "available", total: 0, rows: [] },
      commands: { status: "available", total: 0, accepted: 0, impasse: 0 },
      workers: { status: "available", states: {} },
    };

    // Each of these used to pass the shallow check and then throw inside the
    // reducer, which the sweep reported as a COLLECTOR failure.
    for (const broken of [
      { ...observation, watermarks: { received: 200 } },
      { ...observation, watermarks: null },
      { ...observation, projectionOverThresholdSince: "not-a-date" },
      { ...observation, hostBacklog: { status: "weird" } },
      { ...observation, projectionBacklog: { status: "available" } },
      { ...observation, verdict: "made_up" },
      { ...observation, transition: "made_up" },
      { ...observation, streamState: "made_up" },
    ]) {
      expect(
        parseExecutionObservability({ ...encoded, stream: broken }),
        JSON.stringify(broken).slice(0, 80),
      ).toBeNull();
    }
  });
});

describe("boundExecutionObservability", () => {
  function summary(
    overrides: Partial<ExecutionObservabilitySummary> = {},
  ): ExecutionObservabilitySummary {
    return {
      schemaVersion: 1,
      attemptId: "attempt-1",
      observerId: "observer-a",
      sampledAt: "2026-09-22T12:00:00.000Z",
      quality: "complete",
      errors: [],
      stream: null,
      consumers: {
        status: "available",
        total: 0,
        maximumBacklog: "0",
        top: [],
      },
      poison: { status: "available", total: 0, rows: [] },
      commands: { status: "available", total: 0, accepted: 0, impasse: 0 },
      workers: { status: "available", states: {} },
      ...overrides,
    } as ExecutionObservabilitySummary;
  }

  it("O3: keeps a small summary whole", () => {
    const small = summary();

    expect(boundExecutionObservability(small)).toBe(small);
  });

  it("O3: drops the bounded row lists before the 64 KiB cap, recording the count", () => {
    const top = Array.from({ length: 20 }, (_, index) => ({
      consumerName: `consumer-${index}`.padEnd(4_000, "x"),
      runId: `run-${index}`,
      runStatus: "Running",
      executionHostId: "host-1",
      runHorizonSequence: "100",
      lastRunSequence: "0",
      backlog: "100",
      diagnostic: null,
      lastServedAt: null,
      serviceAgeMs: null,
      state: "ready",
      nextRetryAt: null,
      latestNodeErrorCode: null,
    }));
    const bounded = boundExecutionObservability(
      summary({
        consumers: {
          status: "available",
          total: 20,
          maximumBacklog: "100",
          top,
        },
      } as unknown as Partial<ExecutionObservabilitySummary>),
    );

    expect(bounded.consumers.top).toEqual([]);
    expect(bounded.consumers.truncated).toBe(20);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThan(
      65_536,
    );
  });

  it("O3: refuses a summary still oversized after the rows are dropped", () => {
    expect(() =>
      boundExecutionObservability(summary({ errors: ["x".repeat(70_000)] })),
    ).toThrow(RangeError);
  });
});

describe("createExecutionObservability", () => {
  it("measures the projection lane over the consumers that DO report", () => {
    const model = {
      sampledAt: "2026-09-22T12:00:00.000Z",
      streams: [],
      consumers: {
        eligiblePopulation: 3,
        totalConsumers: 3,
        displayed: 3,
        truncated: 0,
        maximumBacklog: "7",
        diagnosticCount: 1,
        byHost: [
          {
            executionHostId: "host-1",
            consumerCount: 3,
            maximumBacklog: "7",
            diagnosticCount: 1,
          },
        ],
        top: [],
        diagnostics: [],
      },
      poison: { total: 0, displayed: 0, nextAfter: null, rows: [] },
      commands: {
        total: 0,
        queued: 0,
        delivering: 0,
        accepted: 0,
        acceptedWithoutTimestamp: 0,
        oldestAcceptedAt: null,
        oldestAcceptedAgeMs: null,
      },
    } as never;
    const observation = createExecutionObservability({
      attemptId: "attempt-1",
      observerId: "observer-a",
      model,
      previous: null,
      workers: {},
      impasse: null,
      lagAgeMs: 120_000,
    });

    // One inconsistent cursor is surfaced as an error, NOT as a blanked lane:
    // otherwise an open incident could never clear.
    expect(observation.errors).toContain("consumer:cursor_ahead_of_horizon");
    expect(observation.consumers.status).toBe("available");
  });
});
