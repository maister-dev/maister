import { describe, expect, it } from "vitest";

import { recoveredRunLaunchInput } from "@/lib/runs/recover";

describe("recoveredRunLaunchInput", () => {
  it("reconstructs runner-snapshot launches including permission policy args", () => {
    expect(
      recoveredRunLaunchInput({
        runnerSnapshot: {
          id: "claude-dangerous",
          adapter: "claude",
          capabilityAgent: "claude",
          model: "sonnet",
          provider: { kind: "anthropic" },
          providerKind: "anthropic",
          permissionPolicy: "dangerously_skip_permissions",
          sidecarId: null,
        },
      }),
    ).toEqual({
      executor: {
        agent: "claude",
        model: "sonnet",
        router: undefined,
      },
      runner: {
        version: 1,
        runnerId: "claude-dangerous",
        adapter: "claude",
        capabilityAgent: "claude",
        model: "sonnet",
        provider: { kind: "anthropic" },
        permissionPolicy: "dangerously_skip_permissions",
      },
      adapterLaunch: { preArgs: ["--dangerously-skip-permissions"] },
    });
  });

  it("returns null when no runner snapshot exists", () => {
    expect(
      recoveredRunLaunchInput({
        runnerSnapshot: null,
      }),
    ).toBeNull();
  });

  it("recovers OpenAI-compatible runner snapshots after catalog mutation", () => {
    expect(
      recoveredRunLaunchInput({
        runnerSnapshot: {
          id: "codex-glm",
          adapter: "codex",
          capabilityAgent: "codex",
          model: "glm-5.1",
          provider: {
            kind: "openai_compatible",
            baseUrl: "https://api.z.ai/api/paas/v4/",
            apiKey: "env:ZAI_API_KEY",
            wireApi: "responses",
          },
          providerKind: "openai_compatible",
          permissionPolicy: "default",
          sidecarId: null,
        },
      }),
    ).toEqual({
      executor: {
        agent: "codex",
        model: "glm-5.1",
        router: undefined,
      },
      runner: {
        version: 1,
        runnerId: "codex-glm",
        adapter: "codex",
        capabilityAgent: "codex",
        model: "glm-5.1",
        provider: {
          kind: "openai_compatible",
          baseUrl: "https://api.z.ai/api/paas/v4/",
          apiKeyEnv: "ZAI_API_KEY",
          wireApi: "responses",
        },
        permissionPolicy: "default",
      },
      adapterLaunch: undefined,
    });
  });
});
