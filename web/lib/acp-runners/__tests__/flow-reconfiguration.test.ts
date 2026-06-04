import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import { missingAcpRunnerTargets } from "@/lib/acp-runners/flow-reconfiguration";

function graphFlow(nodes: NonNullable<FlowYamlV1["nodes"]>): FlowYamlV1 {
  return {
    schemaVersion: 1,
    name: "Runner Target Flow",
    compat: { engine_min: "1.1.0" },
    nodes,
  };
}

describe("missingAcpRunnerTargets", () => {
  it("finds AI-coding ACP runner targets absent from the platform catalog", () => {
    const missing = missingAcpRunnerTargets({
      flowRevisionId: "rev-1",
      platformRunnerIds: new Set(["claude-code"]),
      manifest: {
        ...graphFlow([
          {
            id: "implement",
            type: "ai_coding",
            action: { prompt: "implement" },
            settings: { runner_type: "acp", runner: "claude-glm" },
            transitions: { success: "done" },
          },
        ]),
        runner_profiles: {
          "claude-glm": {
            runner_type: "acp",
            capability_agent: "claude",
            adapter: "claude",
            model: "glm-5.1",
            permission_policy: "default",
            provider: {
              kind: "anthropic_compatible",
              base_url: "https://api.z.ai/api/anthropic",
              requires_auth_token: true,
            },
            sidecar: { kind: "ccr", optional: false },
          },
        },
      },
    });

    expect(missing).toEqual([
      {
        flowRevisionId: "rev-1",
        stepId: "implement",
        sourceRunnerId: "claude-glm",
        runnerProfile: {
          runner_type: "acp",
          capability_agent: "claude",
          adapter: "claude",
          model: "glm-5.1",
          permission_policy: "default",
          provider: {
            kind: "anthropic_compatible",
            base_url: "https://api.z.ai/api/anthropic",
            requires_auth_token: true,
          },
          sidecar: { kind: "ccr", optional: false },
        },
      },
    ]);
  });

  it("does not create requirements for runner targets already in the catalog", () => {
    expect(
      missingAcpRunnerTargets({
        flowRevisionId: "rev-1",
        platformRunnerIds: new Set(["claude-glm"]),
        manifest: graphFlow([
          {
            id: "implement",
            type: "ai_coding",
            action: { prompt: "implement" },
            settings: { runner_type: "acp", runner: "claude-glm" },
            transitions: { success: "done" },
          },
        ]),
      }),
    ).toEqual([]);
  });

  it("ignores non-AI-coding nodes and settings without explicit runner targets", () => {
    expect(
      missingAcpRunnerTargets({
        flowRevisionId: "rev-1",
        platformRunnerIds: new Set(),
        manifest: graphFlow([
          {
            id: "check",
            type: "check",
            action: { command: "true" },
            transitions: { success: "done" },
          },
          {
            id: "implement",
            type: "ai_coding",
            action: { prompt: "implement" },
            transitions: { success: "done" },
          },
        ]),
      }),
    ).toEqual([]);
  });
});
