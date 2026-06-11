import { describe, expect, it } from "vitest";

import {
  getAdapterSupport,
  parsePlatformRuntimeConfig,
} from "@/lib/acp-runners/schema";

describe("platform ACP runner config schema", () => {
  it("parses platform runners, router sidecars, and derives capability agent from adapter registry", () => {
    const config = parsePlatformRuntimeConfig({
      platform: { default_runner: "claude-code" },
      router_instances: [
        {
          id: "ccr-default",
          kind: "ccr",
          lifecycle: "managed",
          command_preset: "ccr_start",
          config_path: "~/.claude-code-router/config.json",
          base_url: "http://127.0.0.1:3456",
          healthcheck_url: "http://127.0.0.1:3456/health",
          auth_token: "env:MAISTER_CCR_AUTH_TOKEN",
        },
      ],
      acp_runners: [
        {
          id: "claude-code",
          adapter: "claude",
          model: "claude-sonnet-4-6",
          provider: { kind: "anthropic" },
          permission_policy: "default",
        },
        {
          id: "claude-code-ccr",
          adapter: "claude",
          model: "glm-5.1",
          provider: {
            kind: "anthropic_compatible",
            auth_token: "env:ZAI_API_KEY",
          },
          router_instance: "ccr-default",
          permission_policy: "default",
        },
      ],
    });

    expect(config.platform.defaultRunnerId).toBe("claude-code");
    expect(config.routerInstances).toHaveLength(1);
    expect(config.acpRunners).toEqual([
      expect.objectContaining({
        id: "claude-code",
        adapter: "claude",
        capabilityAgent: "claude",
      }),
      expect.objectContaining({
        id: "claude-code-ccr",
        sidecarId: "ccr-default",
        capabilityAgent: "claude",
        provider: expect.objectContaining({
          authToken: "env:ZAI_API_KEY",
        }),
      }),
    ]);
  });

  it("rejects raw provider tokens and accepts only env secret refs", () => {
    expect(() =>
      parsePlatformRuntimeConfig({
        platform: { default_runner: "codex-qwen" },
        acp_runners: [
          {
            id: "codex-qwen",
            adapter: "codex",
            model: "qwen3.6-plus",
            provider: {
              kind: "openai_compatible",
              base_url:
                "https://dashscope-intl.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1",
              api_key: "sk-raw-token",
              wire_api: "responses",
            },
            permission_policy: "default",
          },
        ],
      }),
    ).toThrow(/api_key.*env:/);
  });

  it("parses Gemini, OpenCode, and MiMo runner providers from the shared adapter registry", () => {
    const config = parsePlatformRuntimeConfig({
      platform: { default_runner: "gemini-cli" },
      acp_runners: [
        {
          id: "gemini-cli",
          adapter: "gemini",
          model: "gemini-3-pro",
          provider: { kind: "google_gemini", api_key: "env:GEMINI_API_KEY" },
          permission_policy: "default",
        },
        {
          id: "opencode-native",
          adapter: "opencode",
          model: "opencode-default",
          provider: { kind: "agent_native" },
          permission_policy: "default",
        },
        {
          id: "mimo-code-native",
          adapter: "mimo",
          model: "mimo-native",
          provider: { kind: "agent_native" },
          permission_policy: "default",
        },
      ],
    });

    expect(config.acpRunners).toEqual([
      expect.objectContaining({
        id: "gemini-cli",
        adapter: "gemini",
        capabilityAgent: "gemini",
        provider: { kind: "google_gemini", apiKey: "env:GEMINI_API_KEY" },
      }),
      expect.objectContaining({
        id: "opencode-native",
        adapter: "opencode",
        capabilityAgent: "opencode",
        provider: { kind: "agent_native" },
      }),
      expect.objectContaining({
        id: "mimo-code-native",
        adapter: "mimo",
        capabilityAgent: "mimo",
        provider: { kind: "agent_native" },
      }),
    ]);
  });

  it("rejects unknown adapters, missing sidecars, and invalid defaults", () => {
    expect(() =>
      parsePlatformRuntimeConfig({
        platform: { default_runner: "unknown-default" },
        acp_runners: [
          {
            id: "codex-openai",
            adapter: "codex",
            model: "gpt-5-codex",
            provider: { kind: "openai" },
            permission_policy: "default",
          },
        ],
      }),
    ).toThrow(/default_runner.*unknown-default/);

    expect(() =>
      parsePlatformRuntimeConfig({
        platform: { default_runner: "gemini-runner" },
        acp_runners: [
          {
            id: "gemini-runner",
            adapter: "gemini",
            model: "gemini-3",
            provider: { kind: "openai_compatible" },
            permission_policy: "default",
          },
        ],
      }),
    ).toThrow(/adapter.*gemini.*provider.*openai_compatible/);

    expect(() =>
      parsePlatformRuntimeConfig({
        platform: { default_runner: "claude-code-ccr" },
        acp_runners: [
          {
            id: "claude-code-ccr",
            adapter: "claude",
            model: "glm-5.1",
            provider: { kind: "anthropic_compatible" },
            router_instance: "missing-sidecar",
            permission_policy: "default",
          },
        ],
      }),
    ).toThrow(/router_instance.*missing-sidecar/);
  });

  it("exposes adapters as code-owned diagnostics, not CRUD config", () => {
    expect(getAdapterSupport()).toEqual([
      expect.objectContaining({
        id: "claude",
        capabilityAgent: "claude",
        providerKinds: expect.arrayContaining(["anthropic"]),
      }),
      expect.objectContaining({
        id: "codex",
        capabilityAgent: "codex",
        providerKinds: expect.arrayContaining(["openai"]),
      }),
      expect.objectContaining({
        id: "gemini",
        capabilityAgent: "gemini",
        providerKinds: expect.arrayContaining([
          "google_gemini",
          "google_vertex",
          "google_gateway",
        ]),
      }),
      expect.objectContaining({
        id: "opencode",
        capabilityAgent: "opencode",
        providerKinds: expect.arrayContaining(["agent_native"]),
      }),
      expect.objectContaining({
        id: "mimo",
        capabilityAgent: "mimo",
        providerKinds: expect.arrayContaining(["agent_native"]),
      }),
    ]);
  });
});
