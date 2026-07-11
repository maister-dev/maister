import type { FlowYamlV1 } from "@/lib/config.schema";
import type { NodeAttempt } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import { buildFlightProgress } from "@/lib/queries/board-progress";

type AttemptSeed = Pick<
  NodeAttempt,
  "attempt" | "nodeId" | "startedAt" | "status"
>;

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

  it("renders a stable unavailable projection for incompatible stored manifests", () => {
    const progress = buildFlightProgress({
      currentStepId: "review",
      manifest: {},
      nodeAttempts: [],
      runStatus: "NeedsInput",
    });

    expect(progress.activeNode).toBeNull();
    expect(progress.stepLabel).toBe("review");
    expect(progress.spine).toHaveLength(7);
    expect(progress.spine.every((segment) => segment.state === "todo")).toBe(
      true,
    );
  });
});
