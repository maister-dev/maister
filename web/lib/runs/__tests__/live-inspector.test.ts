import { describe, expect, it } from "vitest";

import {
  CHANGE_SUMMARY_REFRESH_DEBOUNCE_MS,
  changeSummaryRefreshUrl,
  isLiveRunStatus,
} from "@/lib/runs/live-inspector";

describe("isLiveRunStatus", () => {
  it("treats terminal statuses as not live (no SSE subscription)", () => {
    for (const status of ["Done", "Abandoned", "Failed", "Crashed"]) {
      expect(isLiveRunStatus(status)).toBe(false);
    }
  });

  it("treats active statuses as live", () => {
    for (const status of [
      "Running",
      "NeedsInput",
      "NeedsInputIdle",
      "HumanWorking",
      "Review",
      "Pending",
    ]) {
      expect(isLiveRunStatus(status)).toBe(true);
    }
  });
});

describe("changeSummaryRefreshUrl", () => {
  it("builds an encoded change-summary url", () => {
    expect(changeSummaryRefreshUrl("run-1", "run")).toBe(
      "/api/runs/run-1/change-summary?scope=run",
    );
    expect(changeSummaryRefreshUrl("a/b", "uncommitted")).toBe(
      "/api/runs/a%2Fb/change-summary?scope=uncommitted",
    );
  });

  it("exposes a positive debounce window", () => {
    expect(CHANGE_SUMMARY_REFRESH_DEBOUNCE_MS).toBeGreaterThan(0);
  });
});
