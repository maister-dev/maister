import { describe, expect, it } from "vitest";

import {
  INVALID_LOCAL_FLOW_MANIFEST_REMEDIATION,
  classifyLocalPackageCutCompatibility,
} from "@/lib/local-packages/cut-compatibility";
import { LEGACY_STEPS_REFUSAL_MESSAGE } from "@/lib/flows/manifest-shape";

describe("local package cut compatibility", () => {
  it("refuses legacy steps with the locked migration guidance", () => {
    expect(
      classifyLocalPackageCutCompatibility([
        {
          path: "flows/bugfix/flow.yaml",
          content: "schemaVersion: 1\nname: Old\nsteps: []\n",
        },
      ]),
    ).toEqual({
      compatible: false,
      incompatibilityReason: LEGACY_STEPS_REFUSAL_MESSAGE,
    });
  });

  it("gives an invalid graph manifest distinct remediation", () => {
    expect(
      classifyLocalPackageCutCompatibility([
        {
          path: "flows/bugfix/flow.yaml",
          content: "schemaVersion: 1\nname: Broken\nnodes: not-an-array\n",
        },
      ]),
    ).toEqual({
      compatible: false,
      incompatibilityReason: INVALID_LOCAL_FLOW_MANIFEST_REMEDIATION,
    });
  });

  it("keeps an engine-incompatible graph's canonical remediation", () => {
    expect(
      classifyLocalPackageCutCompatibility([
        {
          path: "flows/bugfix/flow.yaml",
          content:
            'schemaVersion: 1\nname: Future\ncompat:\n  engine_min: 4.0.0\nnodes:\n  - id: done\n    type: cli\n    action:\n      command: "true"\n    transitions: {}\n',
        },
      ]),
    ).toEqual({
      compatible: false,
      incompatibilityReason: "engine 3.0.0 < engine_min 4.0.0",
    });
  });

  it("accepts graph-only package flows", () => {
    expect(
      classifyLocalPackageCutCompatibility([
        {
          path: "flows/bugfix/flow.yaml",
          content:
            'schemaVersion: 1\nname: Graph\nnodes:\n  - id: done\n    type: cli\n    action:\n      command: "true"\n    transitions: {}\n',
        },
      ]),
    ).toEqual({ compatible: true, incompatibilityReason: null });
  });
});
