import { describe, expect, it } from "vitest";

import {
  mergeRunnerAdapterLaunch,
  runnerExecutorInput,
  runnerSupervisorInput,
} from "@/lib/acp-runners/spawn-intent";

describe("runner spawn intent", () => {
  it("converts a runner snapshot into the supervisor executor payload", () => {
    expect(
      runnerExecutorInput({
        id: "claude-code-ccr",
        adapter: "claude",
        capabilityAgent: "claude",
        model: "glm-5.1",
        providerKind: "anthropic_compatible",
        permissionPolicy: "default",
        sidecarId: "ccr-default",
      }),
    ).toEqual({
      agent: "claude",
      model: "glm-5.1",
      router: "ccr",
    });
  });

  it("adds Claude dangerous permission args without dropping existing adapter env", () => {
    expect(
      mergeRunnerAdapterLaunch(
        {
          id: "claude-code-dangerous",
          adapter: "claude",
          capabilityAgent: "claude",
          model: "claude-sonnet-4-6",
          providerKind: "anthropic",
          permissionPolicy: "dangerously_skip_permissions",
        },
        { env: { MAISTER_CAPABILITY_PROFILE_PATH: "/profile.json" } },
      ),
    ).toEqual({
      env: { MAISTER_CAPABILITY_PROFILE_PATH: "/profile.json" },
      preArgs: ["--dangerously-skip-permissions"],
    });
  });

  it("builds the versioned supervisor runner payload from immutable snapshot details", () => {
    expect(
      runnerSupervisorInput({
        snapshot: {
          id: "claude-code-ccr",
          adapter: "claude",
          capabilityAgent: "claude",
          model: "glm-5.1",
          provider: {
            kind: "anthropic_compatible",
            baseUrl: "https://api.z.ai/api/anthropic",
          },
          providerKind: "anthropic_compatible",
          permissionPolicy: "default",
          sidecar: {
            id: "ccr-default",
            kind: "ccr",
            authTokenRef: "env:MAISTER_CCR_AUTH_TOKEN",
          },
          sidecarId: "ccr-default",
        },
      }),
    ).toEqual({
      version: 1,
      runnerId: "claude-code-ccr",
      adapter: "claude",
      capabilityAgent: "claude",
      model: "glm-5.1",
      provider: {
        kind: "anthropic_compatible",
        baseUrl: "https://api.z.ai/api/anthropic",
      },
      permissionPolicy: "default",
      sidecar: {
        id: "ccr-default",
        kind: "ccr",
        authTokenEnv: "MAISTER_CCR_AUTH_TOKEN",
      },
    });
  });

  it("maps direct Anthropic-compatible provider env refs into supervisor input", () => {
    expect(
      runnerSupervisorInput({
        snapshot: {
          id: "claude-code-env-router",
          adapter: "claude",
          capabilityAgent: "claude",
          model: "glm-5.1",
          provider: {
            kind: "anthropic_compatible",
            authToken: "env:ZAI_API_KEY",
            baseUrl: "https://api.z.ai/api/anthropic",
          },
          providerKind: "anthropic_compatible",
          permissionPolicy: "default",
        },
      }).provider,
    ).toEqual({
      kind: "anthropic_compatible",
      authTokenEnv: "ZAI_API_KEY",
      baseUrl: "https://api.z.ai/api/anthropic",
    });
  });

  it("maps Gemini and OpenCode providers into supervisor input", () => {
    expect(
      runnerSupervisorInput({
        snapshot: {
          id: "gemini-cli",
          adapter: "gemini",
          capabilityAgent: "gemini",
          model: "gemini-3-pro",
          provider: {
            kind: "google_gemini",
            apiKey: "env:GEMINI_API_KEY",
          },
          providerKind: "google_gemini",
          permissionPolicy: "default",
        },
      }),
    ).toMatchObject({
      runnerId: "gemini-cli",
      adapter: "gemini",
      capabilityAgent: "gemini",
      provider: {
        kind: "google_gemini",
        apiKeyEnv: "GEMINI_API_KEY",
      },
    });

    expect(
      runnerSupervisorInput({
        snapshot: {
          id: "opencode-native",
          adapter: "opencode",
          capabilityAgent: "opencode",
          model: "opencode-default",
          provider: { kind: "agent_native" },
          providerKind: "agent_native",
          permissionPolicy: "default",
        },
      }).provider,
    ).toEqual({ kind: "agent_native" });
  });
});
