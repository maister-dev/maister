import { describe, expect, it } from "vitest";

import { deriveActivityLiveness } from "@/lib/ext-activity/liveness";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const THRESHOLDS = {
  waitingToolAfterSeconds: 90,
  silentAfterSeconds: 180,
  stalledAfterSeconds: 900,
};

describe("assistant activity liveness", () => {
  it("prioritizes waiting_on_human over every other signal", () => {
    const state = deriveActivityLiveness({
      runStatus: "NeedsInput",
      now: NOW,
      lastMeaningfulAt: new Date("2026-07-26T11:30:00.000Z"),
      waitingOnHumanSince: new Date("2026-07-26T11:20:00.000Z"),
      waitingOnToolSince: new Date("2026-07-26T11:59:00.000Z"),
      thresholds: THRESHOLDS,
    });

    expect(state.state).toBe("waiting_on_human");
    expect(state.summary).toContain("waiting on human");
  });

  it("reports waiting_on_tool once the tool-wait threshold is exceeded", () => {
    const state = deriveActivityLiveness({
      runStatus: "Running",
      now: NOW,
      lastMeaningfulAt: new Date("2026-07-26T11:58:00.000Z"),
      waitingOnHumanSince: null,
      waitingOnToolSince: new Date("2026-07-26T11:58:00.000Z"),
      thresholds: THRESHOLDS,
    });

    expect(state.state).toBe("waiting_on_tool");
    expect(state.summary).toContain("waiting on tool");
  });

  it("reports stalled only for still-running work beyond the stalled threshold", () => {
    const state = deriveActivityLiveness({
      runStatus: "Running",
      now: NOW,
      lastMeaningfulAt: new Date("2026-07-26T11:40:00.000Z"),
      waitingOnHumanSince: null,
      waitingOnToolSince: null,
      thresholds: THRESHOLDS,
    });

    expect(state.state).toBe("stalled");
    expect(state.summary).toContain("stalled");
  });

  it("reports silent before a run becomes stalled", () => {
    const state = deriveActivityLiveness({
      runStatus: "Running",
      now: NOW,
      lastMeaningfulAt: new Date("2026-07-26T11:56:00.000Z"),
      waitingOnHumanSince: null,
      waitingOnToolSince: null,
      thresholds: THRESHOLDS,
    });

    expect(state.state).toBe("silent");
    expect(state.summary).toContain("silent");
  });

  it("reports working for recent activity", () => {
    const state = deriveActivityLiveness({
      runStatus: "Running",
      now: NOW,
      lastMeaningfulAt: new Date("2026-07-26T11:59:30.000Z"),
      waitingOnHumanSince: null,
      waitingOnToolSince: null,
      thresholds: THRESHOLDS,
    });

    expect(state.state).toBe("working");
    expect(state.summary).toBe("working");
  });

  it("reports inactive summaries for terminal runs", () => {
    const state = deriveActivityLiveness({
      runStatus: "Done",
      now: NOW,
      lastMeaningfulAt: new Date("2026-07-26T11:20:00.000Z"),
      waitingOnHumanSince: null,
      waitingOnToolSince: null,
      endedAt: new Date("2026-07-26T11:25:00.000Z"),
      thresholds: THRESHOLDS,
    });

    expect(state.state).toBe("inactive");
    expect(state.summary).toBe("completed");
    expect(state.since?.toISOString()).toBe("2026-07-26T11:25:00.000Z");
  });
});
