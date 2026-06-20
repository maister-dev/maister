import { describe, expect, it } from "vitest";

import {
  RUN_STATUS_BADGE_CLASS,
  RUN_STATUS_DOT_CLASS,
  RUN_STATUS_KEYS,
  runStatusTone,
  type RunStatusKey,
  type RunStatusTone,
} from "@/lib/runs/run-status-tone";

// M37 (ADR-098/097): the run-status → tone mapping is the SSOT for the
// orchestrator run-tree + inspector dot/badge colors. A table over every
// runs.status value keeps the mapping honest (esp. the M37 WaitingOnChildren →
// "waiting" tone) and proves the dot/badge Records cover every tone.
const EXPECTED_TONE: Record<RunStatusKey, RunStatusTone> = {
  Pending: "pending",
  Running: "running",
  NeedsInput: "needs",
  NeedsInputIdle: "needs",
  HumanWorking: "human",
  WaitingOnChildren: "waiting",
  Review: "review",
  Crashed: "crashed",
  Done: "done",
  Abandoned: "pending",
  Failed: "crashed",
};

describe("runStatusTone", () => {
  it.each(RUN_STATUS_KEYS)("maps %s to its tone", (status) => {
    expect(runStatusTone(status)).toBe(EXPECTED_TONE[status]);
  });

  it("maps the M37 WaitingOnChildren status to the dedicated 'waiting' tone", () => {
    expect(runStatusTone("WaitingOnChildren")).toBe("waiting");
  });

  it("falls back to 'pending' for an unknown status", () => {
    expect(runStatusTone("Bogus")).toBe("pending");
    expect(runStatusTone("")).toBe("pending");
  });

  it("the dot + badge class maps cover every tone produced by the mapping", () => {
    const tones = new Set<RunStatusTone>(
      RUN_STATUS_KEYS.map((s) => runStatusTone(s)),
    );

    for (const tone of tones) {
      expect(RUN_STATUS_DOT_CLASS[tone]).toBeTruthy();
      expect(RUN_STATUS_BADGE_CLASS[tone]).toBeTruthy();
    }
  });
});
