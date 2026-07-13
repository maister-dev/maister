import { describe, expect, it } from "vitest";

import { derivePortfolioOnboarding } from "@/lib/portfolio-onboarding";

describe("portfolio onboarding", () => {
  it("does not treat an attached but disabled Flow as launchable", () => {
    expect(
      derivePortfolioOnboarding({
        enabledFlowCount: 0,
        taskFlowRunCount: 0,
        visibleProjectCount: 1,
      }),
    ).toEqual({ connected: true, flowReady: false, taskLaunched: false });
  });

  it("requires a task-linked Flow run rather than a scratch or agent run", () => {
    expect(
      derivePortfolioOnboarding({
        enabledFlowCount: 1,
        taskFlowRunCount: 0,
        visibleProjectCount: 1,
      }),
    ).toEqual({ connected: true, flowReady: true, taskLaunched: false });
  });

  it("uses only visible project aggregates", () => {
    expect(
      derivePortfolioOnboarding({
        enabledFlowCount: 0,
        taskFlowRunCount: 0,
        visibleProjectCount: 0,
      }),
    ).toEqual({ connected: false, flowReady: false, taskLaunched: false });
  });
});
