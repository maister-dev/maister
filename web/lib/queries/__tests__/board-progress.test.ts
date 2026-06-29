import type { FlowYamlV1 } from "@/lib/config.schema";
import type { NodeAttempt, StepRun } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import { buildFlightProgress } from "@/lib/queries/board-progress";

type AttemptSeed = Pick<
  NodeAttempt,
  "attempt" | "nodeId" | "startedAt" | "status"
>;

type StepSeed = Pick<StepRun, "startedAt" | "status" | "stepId">;

const graphManifest: FlowYamlV1 = {
  schemaVersion: 1,
  name: "AIF",
  nodes: [
    {
      action: { prompt: "plan" },
      id: "plan",
      type: "ai_coding",
      transitions: { success: "implement" },
    },
    {
      action: { prompt: "plan" },
      id: "implement",
      type: "ai_coding",
      transitions: { success: "review" },
    },
    {
      action: { prompt: "review" },
      id: "review",
      type: "judge",
      transitions: { approve: "done" },
    },
  ],
};

function attempt(over: Partial<AttemptSeed>): AttemptSeed {
  return {
    attempt: 1,
    nodeId: "plan",
    startedAt: new Date("2026-06-01T10:00:00.000Z"),
    status: "Succeeded",
    ...over,
  };
}

function step(over: Partial<StepSeed>): StepSeed {
  return {
    startedAt: new Date("2026-06-01T10:00:00.000Z"),
    status: "Succeeded",
    stepId: "plan",
    ...over,
  };
}

describe("buildFlightProgress", () => {
  it("separates graph-wide progress from the active node state", () => {
    const progress = buildFlightProgress({
      currentStepId: "implement",
      manifest: graphManifest,
      nodeAttempts: [
        attempt({ nodeId: "plan", status: "Succeeded" }),
        attempt({ nodeId: "implement", status: "Running" }),
      ],
      runStatus: "Running",
      stepRuns: [],
    });

    expect(progress.stepLabel).toBe("implement");
    expect(progress.activeNode).toEqual({
      label: "implement",
      state: "running",
    });
    expect(progress.spine).toEqual([
      { state: "done" },
      { state: "active", tone: "running" },
      { state: "todo" },
    ]);
  });

  it("uses the failed latest attempt as the active node when a crashed run cleared currentStepId", () => {
    const progress = buildFlightProgress({
      currentStepId: null,
      manifest: graphManifest,
      nodeAttempts: [
        attempt({ nodeId: "plan", status: "Succeeded" }),
        attempt({
          nodeId: "implement",
          startedAt: new Date("2026-06-01T10:03:00.000Z"),
          status: "Failed",
        }),
      ],
      runStatus: "Crashed",
      stepRuns: [],
    });

    expect(progress.stepLabel).toBe("implement");
    expect(progress.activeNode).toEqual({
      label: "implement",
      state: "failed",
    });
    expect(progress.spine).toEqual([
      { state: "done" },
      { state: "active", tone: "failed" },
      { state: "todo" },
    ]);
  });

  it("keeps the legacy step-run fallback for manifests without a graph", () => {
    const progress = buildFlightProgress({
      currentStepId: "review",
      manifest: {},
      nodeAttempts: [],
      runStatus: "NeedsInput",
      stepRuns: [
        step({ stepId: "plan", status: "Succeeded" }),
        step({
          startedAt: new Date("2026-06-01T10:01:00.000Z"),
          status: "NeedsInput",
          stepId: "review",
        }),
      ],
    });

    expect(progress.activeNode).toEqual({
      label: "review",
      state: "needs",
    });
    expect(progress.spine.slice(0, 3)).toEqual([
      { state: "done" },
      { state: "active", tone: "needs" },
      { state: "todo" },
    ]);
  });
});
