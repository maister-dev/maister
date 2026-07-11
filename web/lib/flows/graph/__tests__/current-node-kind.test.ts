import { describe, expect, it } from "vitest";

import { resolveNodeRecoverInfo } from "@/lib/flows/graph/current-node-kind";

const engineExcludedGraphManifest = {
  schemaVersion: 1,
  name: "engine-excluded-graph",
  compat: { engine_max: "2.2.0" },
  nodes: [
    {
      id: "implement",
      type: "ai_coding",
      action: { prompt: "Implement the change" },
      transitions: { success: "done" },
    },
  ],
};

function dbWithRevisionManifest(manifest: unknown): unknown {
  return {
    select: () => ({
      from: () => ({
        where: async () => [{ manifest }],
      }),
    }),
  };
}

describe("resolveNodeRecoverInfo — incompatible stored graph", () => {
  it("degrades to a non-recoverable target instead of compiling an engine-excluded graph", async () => {
    await expect(
      resolveNodeRecoverInfo(
        dbWithRevisionManifest(engineExcludedGraphManifest) as never,
        {
          flowRevisionId: "revision-1",
          flowId: "flow-1",
          stepId: "implement",
        },
      ),
    ).resolves.toEqual({ nodeKind: null, retrySafe: false });
  });
});
