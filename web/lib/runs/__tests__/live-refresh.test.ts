import { describe, it, expect } from "vitest";

import { runViewKey, shouldRefreshRunView } from "@/lib/runs/live-refresh";

describe("shouldRefreshRunView", () => {
  it("does NOT refresh while only content advances (same status + step)", () => {
    const seen = runViewKey({ runStatus: "Running", currentStepId: "plan" });

    // An ai_coding node streaming chunks keeps the same status+step → no
    // full-tree refresh storm.
    expect(
      shouldRefreshRunView(seen, {
        runStatus: "Running",
        currentStepId: "plan",
      }),
    ).toBe(false);
  });

  it("refreshes when the run status transitions (Running -> NeedsInput)", () => {
    const seen = runViewKey({ runStatus: "Running", currentStepId: "improve" });

    expect(
      shouldRefreshRunView(seen, {
        runStatus: "NeedsInput",
        currentStepId: "plan_review",
      }),
    ).toBe(true);
  });

  it("refreshes when the current node advances at the same status", () => {
    const seen = runViewKey({ runStatus: "Running", currentStepId: "plan" });

    expect(
      shouldRefreshRunView(seen, {
        runStatus: "Running",
        currentStepId: "improve",
      }),
    ).toBe(true);
  });

  it("treats null currentStepId stably (no spurious refresh)", () => {
    const seen = runViewKey({ runStatus: "Pending", currentStepId: null });

    expect(
      shouldRefreshRunView(seen, { runStatus: "Pending", currentStepId: null }),
    ).toBe(false);
  });
});
