import { describe, expect, it } from "vitest";

import { selectExecutionDataPlaneMode } from "../data-plane-capabilities";

describe("Stage B data-plane capability negotiation", () => {
  it("keeps canonical admission off until all control-plane callers are migrated", () => {
    expect(
      selectExecutionDataPlaneMode({
        dataPlaneVersion: "execution-host-data-plane.v1",
        eventStream: true,
        asyncPrompt: true,
        runtimeObjects: true,
        limits: {
          maxEventBytes: 1_048_576,
          maxObjectBytes: 536_870_912,
          maxReplayBatch: 500,
        },
      }),
    ).toBe("legacy_file_v1");
    expect(selectExecutionDataPlaneMode(null)).toBe("legacy_file_v1");
  });
});
