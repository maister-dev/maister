import { describe, expect, it } from "vitest";

import { buildScratchSessionFlowSummary } from "@/lib/scratch-runs/session-summary";

describe("buildScratchSessionFlowSummary", () => {
  it("maps a scratch session into a flow-summary with dialog + capability rows", () => {
    const summary = buildScratchSessionFlowSummary(
      {
        dialogStatus: "WaitingForUser",
        mcpCount: 2,
        skillCount: 1,
        ruleCount: 0,
      },
      { title: "Session", dialog: "Dialog", capabilities: "Capabilities" },
    );

    expect(summary.title).toBe("Session");
    expect(summary.subtitle).toBe("WaitingForUser");
    expect(summary.nodes).toHaveLength(2);
    expect(summary.nodes[0]).toMatchObject({
      id: "dialog",
      label: "Dialog",
      status: "WaitingForUser",
    });
    expect(summary.nodes[1]).toMatchObject({
      id: "capabilities",
      label: "Capabilities",
      status: "2 · 1 · 0",
    });
  });
});
