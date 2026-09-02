import { describe, expect, it } from "vitest";

import { loadRunManifest } from "@/lib/queries/run-manifest";

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

function dbWithSelections(
  ...selections: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>
): unknown {
  let index = 0;

  return {
    select: () => ({
      from: () => ({
        where: async () => selections[index++] ?? [],
      }),
    }),
  };
}

describe("loadRunManifest — stored engine compatibility", () => {
  it("returns typed incompatibility for a pinned graph that excludes engine 3", async () => {
    const manifest = await loadRunManifest(
      "run-engine-excluded",
      dbWithSelections(
        [
          {
            flowId: "flow-1",
            projectId: "project-1",
            flowRevisionId: "revision-1",
          },
        ],
        [{ manifest: engineExcludedGraphManifest }],
      ) as never,
    );

    expect(manifest).toEqual({
      flowId: "flow-1",
      projectId: "project-1",
      compatible: false,
      manifest: null,
      incompatibility: {
        kind: "engine_incompatible",
        message: "engine 3.7.0 > engine_max 2.2.0",
      },
    });
  });
});
