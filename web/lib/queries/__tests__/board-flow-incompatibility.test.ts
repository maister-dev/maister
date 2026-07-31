import { describe, expect, it } from "vitest";

import { boardFlowIncompatibility } from "@/lib/queries/board";

const graphManifest = {
  schemaVersion: 1,
  name: "board-flow",
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "Implement" },
      transitions: { success: "done" },
    },
  ],
};

describe("boardFlowIncompatibility", () => {
  it("uses the enabled revision manifest and exposes a typed legacy reason", () => {
    expect(
      boardFlowIncompatibility({
        schemaVersion: 1,
        name: "legacy-board-flow",
        steps: [],
      }),
    ).toEqual({
      kind: "legacy_steps",
      reason:
        "legacy steps[] flows are not supported since engine 3.0.0; republish the package with nodes[]",
    });
  });

  it("keeps a compatible enabled revision launchable on the board", () => {
    expect(boardFlowIncompatibility(graphManifest)).toBeNull();
  });

  it("renders a future-engine revision as a typed disabled reason", () => {
    expect(
      boardFlowIncompatibility({
        ...graphManifest,
        compat: { engine_min: "4.0.0" },
      }),
    ).toEqual({
      kind: "engine_incompatible",
      reason: "engine 3.3.0 < engine_min 4.0.0",
    });
  });

  it("honors the revision's persisted engine range before its manifest cache", () => {
    expect(boardFlowIncompatibility(graphManifest, "4.0.0", null)).toEqual({
      kind: "engine_incompatible",
      reason: "engine 3.3.0 < engine_min 4.0.0",
    });
  });
});
