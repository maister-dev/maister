import { describe, expect, it } from "vitest";

import {
  executionDataPlaneModeForHost,
  selectExecutionDataPlaneMode,
} from "../data-plane-capabilities";

describe("Stage B data-plane capability negotiation", () => {
  it("admits canonical runs only on a complete advertised v1 capability set", () => {
    expect(
      selectExecutionDataPlaneMode({
        dataPlaneVersion: "execution-host-data-plane.v1",
        eventStream: true,
        asyncPrompt: true,
        runtimeObjects: true,
      }),
    ).toBe("canonical_events_v1");
    expect(() => selectExecutionDataPlaneMode(null)).toThrow(
      expect.objectContaining({
        code: "EXECUTOR_UNAVAILABLE",
        details: { reason: "data_plane_unsupported" },
      }),
    );
    expect(() =>
      selectExecutionDataPlaneMode({
        dataPlaneVersion: "execution-host-data-plane.v1",
        eventStream: true,
        asyncPrompt: true,
        runtimeObjects: false,
      }),
    ).toThrow("required canonical data plane");
  });

  it("re-parses the durable host capability JSON before admission", () => {
    expect(
      executionDataPlaneModeForHost({
        capabilities: {
          dataPlane: {
            version: "execution-host-data-plane.v1",
            eventStream: true,
            asyncPrompt: true,
            runtimeObjects: true,
          },
        },
      } as never),
    ).toBe("canonical_events_v1");
    expect(() =>
      executionDataPlaneModeForHost({
        capabilities: { dataPlane: { version: "execution-host-data-plane.v1" } },
      } as never),
    ).toThrow("required canonical data plane");
  });
});
