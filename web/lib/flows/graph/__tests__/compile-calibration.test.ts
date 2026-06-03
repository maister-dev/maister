// RED (M15 Phase 1 §Task 3): Compile-time flow-default resolution for gate calibration.
//
// Frozen contract from docs/system-analytics/readiness.md:
// - Flow-level `verdict_calibration.confidence_min` is folded into each
//   `ai_judgment`/`skill_check` gate's effective `calibration.confidence_min` at compile time
// - Per-gate `confidence_min` OVERRIDES the flow default
// - Non-ai/skill gates get NO calibration injected
// - Assert on `CompiledNode.gates[].calibration`

import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { compileManifest } from "@/lib/flows/graph/compile";

describe("compileManifest — flow-level verdict_calibration.confidence_min resolution (M15 §Task 3)", () => {
  it("folds flow-level verdict_calibration.confidence_min into ai_judgment gates lacking per-gate calibration", () => {
    const flow: FlowYamlV1 = {
      schemaVersion: 1,
      name: "test",
      verdict_calibration: {
        confidence_min: 0.7,
      },
      nodes: [
        {
          id: "judge",
          type: "judge",
          action: { prompt: "test" },
          pre_finish: {
            gates: [
              {
                id: "g1",
                kind: "ai_judgment",
                mode: "blocking",
              },
            ],
          },
        },
      ],
    } as FlowYamlV1;

    const compiled = compileManifest(flow);
    const judgeNode = compiled.nodes.get("judge")!;

    expect(judgeNode.gates).toHaveLength(1);
    const g1 = judgeNode.gates[0]!;

    expect(g1.id).toBe("g1");
    expect(
      (g1 as { calibration?: { confidence_min?: number } }).calibration
        ?.confidence_min,
    ).toBe(0.7);
  });

  it("folds flow-level verdict_calibration.confidence_min into skill_check gates lacking per-gate calibration", () => {
    const flow: FlowYamlV1 = {
      schemaVersion: 1,
      name: "test",
      verdict_calibration: {
        confidence_min: 0.75,
      },
      nodes: [
        {
          id: "check",
          type: "cli",
          action: { command: "test" },
          pre_finish: {
            gates: [
              {
                id: "skill",
                kind: "skill_check",
                mode: "blocking",
                skill: "test-skill",
              },
            ],
          },
        },
      ],
    } as FlowYamlV1;

    const compiled = compileManifest(flow);
    const checkNode = compiled.nodes.get("check")!;

    expect(checkNode.gates).toHaveLength(1);
    const skillGate = checkNode.gates[0]!;

    expect(
      (skillGate as { calibration?: { confidence_min?: number } }).calibration
        ?.confidence_min,
    ).toBe(0.75);
  });

  it("per-gate calibration.confidence_min OVERRIDES flow-level default", () => {
    const flow: FlowYamlV1 = {
      schemaVersion: 1,
      name: "test",
      verdict_calibration: {
        confidence_min: 0.7,
      },
      nodes: [
        {
          id: "judge",
          type: "judge",
          action: { prompt: "test" },
          pre_finish: {
            gates: [
              {
                id: "g1",
                kind: "ai_judgment",
                mode: "blocking",
                calibration: {
                  confidence_min: 0.95,
                },
              },
            ],
          },
        },
      ],
    } as FlowYamlV1;

    const compiled = compileManifest(flow);
    const judgeNode = compiled.nodes.get("judge")!;

    expect(judgeNode.gates).toHaveLength(1);
    const g1 = judgeNode.gates[0]!;

    expect(
      (g1 as { calibration?: { confidence_min?: number } }).calibration
        ?.confidence_min,
    ).toBe(0.95);
  });

  it("does NOT inject calibration into non-ai/skill gates even when flow default is set", () => {
    const flow: FlowYamlV1 = {
      schemaVersion: 1,
      name: "test",
      verdict_calibration: {
        confidence_min: 0.8,
      },
      nodes: [
        {
          id: "check",
          type: "cli",
          action: { command: "test" },
          pre_finish: {
            gates: [
              {
                id: "cmd",
                kind: "command_check",
                mode: "blocking",
                command: "test",
              },
              {
                id: "artifact",
                kind: "artifact_required",
                mode: "blocking",
                inputArtifacts: ["diff"],
              },
            ],
          },
        },
      ],
    } as FlowYamlV1;

    const compiled = compileManifest(flow);
    const checkNode = compiled.nodes.get("check")!;

    expect(checkNode.gates).toHaveLength(2);
    const cmdGate = checkNode.gates[0]!;
    const artifactGate = checkNode.gates[1]!;

    // Neither gate should have calibration injected
    expect((cmdGate as { calibration?: unknown }).calibration).toBeUndefined();
    expect(
      (artifactGate as { calibration?: unknown }).calibration,
    ).toBeUndefined();
  });

  it("preserves per-gate allow_missing_confidence when folding flow default", () => {
    const flow: FlowYamlV1 = {
      schemaVersion: 1,
      name: "test",
      verdict_calibration: {
        confidence_min: 0.7,
      },
      nodes: [
        {
          id: "judge",
          type: "judge",
          action: { prompt: "test" },
          pre_finish: {
            gates: [
              {
                id: "g1",
                kind: "ai_judgment",
                mode: "blocking",
                calibration: {
                  allow_missing_confidence: true,
                },
              },
            ],
          },
        },
      ],
    } as FlowYamlV1;

    const compiled = compileManifest(flow);
    const judgeNode = compiled.nodes.get("judge")!;

    expect(judgeNode.gates).toHaveLength(1);
    const g1 = judgeNode.gates[0]!;

    expect(
      (
        g1 as {
          calibration?: {
            confidence_min?: number;
            allow_missing_confidence?: boolean;
          };
        }
      ).calibration?.confidence_min,
    ).toBe(0.7);
    expect(
      (g1 as { calibration?: { allow_missing_confidence?: boolean } })
        .calibration?.allow_missing_confidence,
    ).toBe(true);
  });

  it("handles multiple gates per node with mixed per-gate and flow-default calibration", () => {
    const flow: FlowYamlV1 = {
      schemaVersion: 1,
      name: "test",
      verdict_calibration: {
        confidence_min: 0.6,
      },
      nodes: [
        {
          id: "review",
          type: "judge",
          action: { prompt: "test" },
          pre_finish: {
            gates: [
              {
                id: "g1",
                kind: "ai_judgment",
                mode: "blocking",
                // No per-gate calibration — should fold flow default
              },
              {
                id: "g2",
                kind: "ai_judgment",
                mode: "blocking",
                calibration: {
                  confidence_min: 0.9,
                },
                // Per-gate override
              },
              {
                id: "g3",
                kind: "command_check",
                mode: "blocking",
                command: "lint",
                // Not ai/skill — no calibration injected
              },
            ],
          },
        },
      ],
    } as FlowYamlV1;

    const compiled = compileManifest(flow);
    const reviewNode = compiled.nodes.get("review")!;

    expect(reviewNode.gates).toHaveLength(3);
    const g1 = reviewNode.gates[0]!;
    const g2 = reviewNode.gates[1]!;
    const g3 = reviewNode.gates[2]!;

    expect(
      (g1 as { calibration?: { confidence_min?: number } }).calibration
        ?.confidence_min,
    ).toBe(0.6);
    expect(
      (g2 as { calibration?: { confidence_min?: number } }).calibration
        ?.confidence_min,
    ).toBe(0.9);
    expect((g3 as { calibration?: unknown }).calibration).toBeUndefined();
  });

  it("works when flow has no verdict_calibration (gates unchanged)", () => {
    const flow: FlowYamlV1 = {
      schemaVersion: 1,
      name: "test",
      nodes: [
        {
          id: "judge",
          type: "judge",
          action: { prompt: "test" },
          pre_finish: {
            gates: [
              {
                id: "g1",
                kind: "ai_judgment",
                mode: "blocking",
              },
            ],
          },
        },
      ],
    } as FlowYamlV1;

    const compiled = compileManifest(flow);
    const judgeNode = compiled.nodes.get("judge")!;

    expect(judgeNode.gates).toHaveLength(1);
    const g1 = judgeNode.gates[0]!;

    // With no flow-level default and no per-gate calibration, gate should be unchanged
    expect((g1 as { calibration?: unknown }).calibration).toBeUndefined();
  });

  it("preserves gates as-is when compiled from linear steps[] (no gates)", () => {
    const flow: FlowYamlV1 = {
      schemaVersion: 1,
      name: "test",
      verdict_calibration: {
        confidence_min: 0.8,
      },
      steps: [{ id: "hello", type: "cli", command: "echo hi" }],
    } as FlowYamlV1;

    const compiled = compileManifest(flow);
    const helloNode = compiled.nodes.get("hello")!;

    // Linear-compiled nodes have empty gates[]
    expect(helloNode.gates).toEqual([]);
  });
});
