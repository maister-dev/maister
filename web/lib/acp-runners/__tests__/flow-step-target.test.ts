import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { resolveCompiledStepTargetRunnerId } from "@/lib/acp-runners/flow-step-target";
import { MaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";

function graphFlow(nodes: NonNullable<FlowYamlV1["nodes"]>): FlowYamlV1 {
  return {
    schemaVersion: 1,
    name: "Runner Target Flow",
    compat: { engine_min: "1.1.0" },
    nodes,
  };
}

function targetNode(
  id: string,
  runner: string,
): NonNullable<FlowYamlV1["nodes"]>[number] {
  return {
    id,
    type: "ai_coding",
    action: { prompt: id },
    settings: { runner_type: "acp", runner },
    transitions: { success: "done" },
  };
}

describe("resolveCompiledStepTargetRunnerId", () => {
  it("returns the single AI-coding runner target", () => {
    const runnerId = resolveCompiledStepTargetRunnerId({
      compiled: compileManifest(
        graphFlow([targetNode("implement", "claude-code")]),
      ),
      remaps: [],
      flowRefId: "bugfix",
    });

    expect(runnerId).toBe("claude-code");
  });

  it("uses a mapped remap instead of silently falling back to defaults", () => {
    const runnerId = resolveCompiledStepTargetRunnerId({
      compiled: compileManifest(
        graphFlow([targetNode("implement", "claude-glm")]),
      ),
      remaps: [
        {
          stepId: "implement",
          sourceRunnerId: "claude-glm",
          mappedRunnerId: "claude-code-ccr",
          status: "Mapped",
        },
      ],
      flowRefId: "bugfix",
    });

    expect(runnerId).toBe("claude-code-ccr");
  });

  it("refuses pending remaps before runner resolution can fallback", () => {
    expect(() =>
      resolveCompiledStepTargetRunnerId({
        compiled: compileManifest(
          graphFlow([targetNode("implement", "claude-glm")]),
        ),
        remaps: [
          {
            stepId: "implement",
            sourceRunnerId: "claude-glm",
            mappedRunnerId: null,
            status: "Pending",
          },
        ],
        flowRefId: "bugfix",
      }),
    ).toThrow(MaisterError);
  });

  it("refuses multiple distinct step targets for one workspace launch", () => {
    expect(() =>
      resolveCompiledStepTargetRunnerId({
        compiled: compileManifest(
          graphFlow([
            targetNode("implement", "claude-code"),
            targetNode("review", "codex-openai"),
          ]),
        ),
        remaps: [],
        flowRefId: "bugfix",
      }),
    ).toThrow(/multiple AI-coding runner targets/);
  });
});
