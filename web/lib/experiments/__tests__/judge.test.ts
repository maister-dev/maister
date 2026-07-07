import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launchAgentRun: vi.fn(),
}));

vi.mock("@/lib/agents/launch", () => ({
  launchAgentRun: mocks.launchAgentRun,
}));

describe("launchExperimentJudge", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("dispatches the core judge through the standard manual agent path", async () => {
    mocks.launchAgentRun.mockResolvedValue({
      runId: "run-judge",
      status: "Running",
    });

    const { launchExperimentJudge } = await import("@/lib/experiments/judge");

    const result = await launchExperimentJudge({
      projectId: "project-1",
      taskId: "task-1",
      experimentId: "exp-1",
    });

    expect(result).toEqual({ runId: "run-judge", status: "Running" });
    expect(mocks.launchAgentRun).toHaveBeenCalledWith({
      agentId: "core:experiment-judge",
      projectId: "project-1",
      taskId: "task-1",
      workspace: "none",
      trigger: {
        source: "manual",
        payload: { experimentId: "exp-1" },
      },
    });
  });
});
