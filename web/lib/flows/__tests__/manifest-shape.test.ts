import { describe, expect, it } from "vitest";

import { flowYamlV1Schema } from "@/lib/config.schema";
import {
  isEngineCompatible,
  MAISTER_ENGINE_VERSION,
} from "@/lib/flows/engine-version";
import {
  classifyStoredFlowManifest,
  getFlowManifestIncompatibility,
  parseExecutableStoredFlowManifest,
  parseGraphOnlyFlowManifest,
} from "@/lib/flows/manifest-parser";
import { LEGACY_STEPS_REFUSAL_MESSAGE } from "@/lib/flows/manifest-shape";

const validNode = {
  id: "implement",
  type: "ai_coding",
  action: { prompt: "Implement the change" },
  transitions: { success: "done" },
};

const baseManifest = {
  schemaVersion: 1,
  name: "graph-only-contract",
  compat: { engine_min: "1.1.0" },
};

function issueMessages(value: unknown): string[] {
  const result = flowYamlV1Schema.safeParse(value);

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
}

describe("graph-only manifest shape contract", () => {
  it.each([
    [
      "steps only",
      { ...baseManifest, steps: [{ id: "old", type: "cli", command: "true" }] },
    ],
    ["empty steps", { ...baseManifest, steps: [] }],
    [
      "steps and nodes",
      {
        ...baseManifest,
        steps: [{ id: "old", type: "cli", command: "true" }],
        nodes: [validNode],
      },
    ],
  ])("refuses %s with the exact cut-over remediation", (_label, manifest) => {
    expect(issueMessages(manifest)).toEqual([LEGACY_STEPS_REFUSAL_MESSAGE]);
  });

  it("requires a non-empty nodes[] graph", () => {
    expect(issueMessages({ ...baseManifest, nodes: [] })).toContain(
      "Array must contain at least 1 element(s)",
    );
  });

  it.each([
    ["non-object root", "not-an-object"],
    ["neither-key object", { ...baseManifest }],
    [
      "malformed graph node",
      { ...baseManifest, nodes: [{ id: "broken", type: "unknown" }] },
    ],
  ])("classifies %s as invalid without the legacy refusal", (_label, value) => {
    const result = classifyStoredFlowManifest(value);

    expect(result.compatible).toBe(false);
    if (result.compatible) return;
    expect(result.reason.kind).toBe("invalid_manifest");
    expect(result.reason.message).not.toBe(LEGACY_STEPS_REFUSAL_MESSAGE);
  });

  it("keeps an engine range excluding the current engine distinct from legacy shape", () => {
    const value = {
      ...baseManifest,
      compat: { engine_min: "4.0.0" },
      nodes: [validNode],
    };

    expect(classifyStoredFlowManifest(value)).toMatchObject({
      compatible: false,
      manifest: null,
      manifestShape: "graph",
      reason: {
        kind: "engine_incompatible",
        message: "engine 3.4.0 < engine_min 4.0.0",
      },
    });
    expect(isEngineCompatible(value.compat.engine_min)).toMatchObject({
      compatible: false,
      reason: expect.stringContaining("engine_min"),
    });

    expect(
      parseGraphOnlyFlowManifest(value, {
        code: "CONFIG",
        surface: "intake-shape",
        manifestLabel: "flow.yaml",
      }),
    ).toMatchObject({ nodes: [validNode] });

    try {
      parseExecutableStoredFlowManifest(value, {
        code: "CONFIG",
        surface: "stored-runtime",
        manifestLabel: "flow revision rev-engine-max",
      });
      expect.unreachable("engine-incompatible stored manifest must be refused");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CONFIG",
        message:
          "flow manifest in flow revision rev-engine-max is incompatible with this MAIster engine: engine 3.4.0 < engine_min 4.0.0",
      });
      expect(getFlowManifestIncompatibility(error)).toEqual({
        kind: "engine_incompatible",
        message: "engine 3.4.0 < engine_min 4.0.0",
      });
    }
  });

  it("accepts a valid nodes[] graph and preserves open-ended compatibility", () => {
    expect(
      flowYamlV1Schema.parse({ ...baseManifest, nodes: [validNode] }),
    ).toMatchObject({
      nodes: [validNode],
    });
  });

  it("publishes engine 3.4.0 as the settings.context_repos host contract (ADR-157)", () => {
    expect(MAISTER_ENGINE_VERSION).toBe("3.4.0");
  });

  it("lets the intake caller select FLOW_INSTALL without changing remediation", () => {
    try {
      parseGraphOnlyFlowManifest(
        { ...baseManifest, steps: [{ id: "old", type: "cli" }] },
        {
          code: "FLOW_INSTALL",
          surface: "package-install",
          manifestLabel: "package/flow.yaml",
        },
      );
      expect.unreachable("legacy manifest must be refused");
    } catch (error) {
      expect(error).toMatchObject({
        code: "FLOW_INSTALL",
        message: LEGACY_STEPS_REFUSAL_MESSAGE,
      });
      expect(getFlowManifestIncompatibility(error)).toEqual({
        kind: "legacy_steps",
        message: LEGACY_STEPS_REFUSAL_MESSAGE,
      });
    }
  });

  it("classifies a stored legacy revision without throwing its read model", () => {
    expect(
      classifyStoredFlowManifest({
        ...baseManifest,
        steps: [{ id: "old", type: "cli", command: "true" }],
      }),
    ).toEqual({
      compatible: false,
      manifest: null,
      manifestShape: "legacy_steps",
      reason: {
        kind: "legacy_steps",
        message: LEGACY_STEPS_REFUSAL_MESSAGE,
      },
    });
  });
});
