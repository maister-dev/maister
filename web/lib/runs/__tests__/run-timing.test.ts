import { describe, expect, it } from "vitest";

import { computeRunTiming, type RunTimingEvidence } from "../run-timing";

const MIN = 60_000;

function evidence(over: Partial<RunTimingEvidence> = {}): RunTimingEvidence {
  return {
    startedAt: 0,
    endedAt: 40 * MIN,
    now: 100 * MIN,
    execution: [],
    childExecution: [],
    hitl: [],
    checkpoints: [],
    ...over,
  };
}

describe("computeRunTiming (ADR-208)", () => {
  it("W10 attributes condition waits and readmission separately from execution", () => {
    const timing = computeRunTiming(
      evidence({
        execution: [
          { start: 0, end: 5 * MIN },
          { start: 35 * MIN, end: 40 * MIN },
        ],
        childExecution: [{ start: 10 * MIN, end: 15 * MIN }],
        conditionWaits: [{ start: 5 * MIN, end: 25 * MIN }],
        readmissions: [{ start: 25 * MIN, end: 35 * MIN }],
      }),
    );

    expect(timing).toMatchObject({
      durationMs: 40 * MIN,
      executionMs: 15 * MIN,
      breakdown: {
        admissionMs: 10 * MIN,
        idleMs: 15 * MIN,
        childExecutionMs: 5 * MIN,
        otherMs: 0,
      },
    });
  });
  it("T-1: a 30 min human wait between two 5 min nodes", () => {
    const timing = computeRunTiming(
      evidence({
        execution: [
          { start: 0, end: 5 * MIN },
          { start: 35 * MIN, end: 40 * MIN },
        ],
        hitl: [{ start: 5 * MIN, end: 35 * MIN }],
      }),
    );

    expect(timing).toMatchObject({
      durationMs: 40 * MIN,
      executionMs: 10 * MIN,
      quality: "exact",
      live: false,
      breakdown: {
        admissionMs: 0,
        humanInputMs: 30 * MIN,
        idleMs: 0,
        otherMs: 0,
      },
    });
  });

  it("T-2: two fully overlapping parallel attempts count once", () => {
    expect(
      computeRunTiming(
        evidence({
          endedAt: 10 * MIN,
          execution: [
            { start: 0, end: 10 * MIN },
            { start: 0, end: 10 * MIN },
          ],
        }),
      ).executionMs,
    ).toBe(10 * MIN);
  });

  it("T-3: a retry keeps earlier closed intervals and a checkpoint idle period is excluded", () => {
    const timing = computeRunTiming(
      evidence({
        endedAt: 60 * MIN,
        execution: [
          { start: 0, end: 10 * MIN },
          { start: 10 * MIN, end: 20 * MIN },
          { start: 50 * MIN, end: 60 * MIN },
        ],
        checkpoints: [{ start: 20 * MIN, end: 50 * MIN }],
      }),
    );

    expect(timing.executionMs).toBe(30 * MIN);
    expect(timing.breakdown).toMatchObject({ idleMs: 30 * MIN });
  });

  it("queue/admission before the first execution is a wait, not execution", () => {
    const timing = computeRunTiming(
      evidence({
        endedAt: 20 * MIN,
        execution: [{ start: 5 * MIN, end: 20 * MIN }],
      }),
    );

    expect(timing.executionMs).toBe(15 * MIN);
    expect(timing.breakdown).toMatchObject({ admissionMs: 5 * MIN });
  });

  it("T-4: an attempt still open on a terminal Run is clipped and marked partial", () => {
    expect(
      computeRunTiming(
        evidence({ endedAt: 20 * MIN, execution: [{ start: 0, end: null }] }),
      ),
    ).toMatchObject({ executionMs: 20 * MIN, quality: "partial" });
  });

  it("T-4: no execution evidence is unavailable, never zero", () => {
    expect(computeRunTiming(evidence())).toMatchObject({
      durationMs: 40 * MIN,
      executionMs: null,
      quality: "unavailable",
      breakdown: null,
    });
  });

  it("T-5: a coordinator counts only child execution inside its own window", () => {
    expect(
      computeRunTiming(
        evidence({
          endedAt: 30 * MIN,
          execution: [{ start: 0, end: 5 * MIN }],
          childExecution: [
            { start: 10 * MIN, end: 20 * MIN },
            { start: 25 * MIN, end: 45 * MIN },
          ],
        }),
      ),
    ).toMatchObject({
      executionMs: 20 * MIN,
      breakdown: { childExecutionMs: 15 * MIN },
    });
  });

  it("a live Run measures to now and is labeled live", () => {
    expect(
      computeRunTiming(
        evidence({
          endedAt: null,
          now: 12 * MIN,
          execution: [{ start: 0, end: null }],
        }),
      ),
    ).toMatchObject({
      durationMs: 12 * MIN,
      executionMs: 12 * MIN,
      live: true,
      quality: "exact",
    });
  });

  it("inconsistent evidence (end before start) yields a zero-length window, not a negative one", () => {
    expect(
      computeRunTiming(evidence({ startedAt: 10 * MIN, endedAt: 5 * MIN }))
        .durationMs,
    ).toBe(0);
  });
});
