import { describe, expect, it } from "vitest";

import {
  parseExecutionObservability,
  reduceLagObservation,
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
      sample: sample({ quality: "partial" }),
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
});
