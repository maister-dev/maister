import { describe, expect, it, vi } from "vitest";

import { provisionRunnerLaunch } from "../runner-provisioner";
import { SupervisorError } from "../types";

describe("provisionRunnerLaunch", () => {
  it("maps Claude dangerous policy to an allow-listed preArg", () => {
    expect(
      provisionRunnerLaunch({
        version: 1,
        runnerId: "claude-dangerous",
        adapter: "claude",
        capabilityAgent: "claude",
        model: "sonnet",
        provider: { kind: "anthropic" },
        permissionPolicy: "dangerously_skip_permissions",
      }),
    ).toEqual({
      executor: { agent: "claude", model: "sonnet" },
      adapterLaunch: { preArgs: ["--dangerously-skip-permissions"] },
    });
  });

  it("resolves env refs without exposing raw tokens in the payload", () => {
    vi.stubEnv("ANTHROPIC_COMPAT_TOKEN", "secret-value");

    expect(
      provisionRunnerLaunch({
        version: 1,
        runnerId: "claude-compatible",
        adapter: "claude",
        capabilityAgent: "claude",
        model: "glm",
        provider: {
          kind: "anthropic_compatible",
          baseUrl: "https://example.test/anthropic",
          authTokenEnv: "ANTHROPIC_COMPAT_TOKEN",
        },
        permissionPolicy: "default",
      }),
    ).toEqual({
      executor: {
        agent: "claude",
        model: "glm",
        env: {
          ANTHROPIC_AUTH_TOKEN: "secret-value",
          ANTHROPIC_BASE_URL: "https://example.test/anthropic",
        },
      },
    });

    vi.unstubAllEnvs();
  });

  it("resolves env-prefixed runner env values and keeps raw values literal", () => {
    vi.stubEnv("CLAUDE_BASE_URL_ENV", "https://gateway.example.test");

    expect(
      provisionRunnerLaunch({
        version: 1,
        runnerId: "claude-env-overrides",
        adapter: "claude",
        capabilityAgent: "claude",
        model: "sonnet",
        provider: { kind: "anthropic" },
        permissionPolicy: "default",
        env: {
          ANTHROPIC_BASE_URL: "env:CLAUDE_BASE_URL_ENV",
          ANTHROPIC_MODEL: "claude-sonnet-4-6",
        },
      }),
    ).toEqual({
      executor: {
        agent: "claude",
        model: "sonnet",
        env: {
          ANTHROPIC_BASE_URL: "https://gateway.example.test",
          ANTHROPIC_MODEL: "claude-sonnet-4-6",
        },
      },
    });

    vi.unstubAllEnvs();
  });

  it("maps direct Codex runners without env or argv mutation", () => {
    expect(
      provisionRunnerLaunch({
        version: 1,
        runnerId: "codex-direct",
        adapter: "codex",
        capabilityAgent: "codex",
        model: "gpt-5-codex",
        provider: { kind: "openai" },
        permissionPolicy: "default",
      }),
    ).toEqual({
      executor: { agent: "codex", model: "gpt-5-codex" },
    });
  });

  it("maps Gemini API-key provider env refs into Gemini CLI env", () => {
    vi.stubEnv("GEMINI_UPSTREAM_KEY", "gemini-secret");

    expect(
      provisionRunnerLaunch({
        version: 1,
        runnerId: "gemini-cli",
        adapter: "gemini",
        capabilityAgent: "gemini",
        model: "gemini-3-pro",
        provider: {
          kind: "google_gemini",
          apiKeyEnv: "GEMINI_UPSTREAM_KEY",
        },
        permissionPolicy: "default",
      }),
    ).toEqual({
      executor: {
        agent: "gemini",
        model: "gemini-3-pro",
        env: { GEMINI_API_KEY: "gemini-secret" },
      },
    });

    vi.unstubAllEnvs();
  });

  it("allows Gemini CLI-native auth without env mutation", () => {
    expect(
      provisionRunnerLaunch({
        version: 1,
        runnerId: "gemini-cli",
        adapter: "gemini",
        capabilityAgent: "gemini",
        model: "gemini-3-pro",
        provider: {
          kind: "google_gemini",
        },
        permissionPolicy: "default",
      }),
    ).toEqual({
      executor: { agent: "gemini", model: "gemini-3-pro" },
    });
  });

  it("maps OpenCode native runners without env or argv mutation", () => {
    expect(
      provisionRunnerLaunch({
        version: 1,
        runnerId: "opencode-native",
        adapter: "opencode",
        capabilityAgent: "opencode",
        model: "opencode-default",
        provider: { kind: "agent_native" },
        permissionPolicy: "default",
      }),
    ).toEqual({
      executor: { agent: "opencode", model: "opencode-default" },
    });
  });

  it("maps MiMo native runners without env or argv mutation", () => {
    expect(
      provisionRunnerLaunch({
        version: 1,
        runnerId: "mimo-code-native",
        adapter: "mimo",
        capabilityAgent: "mimo",
        model: "mimo-native",
        provider: { kind: "agent_native" },
        permissionPolicy: "default",
      }),
    ).toEqual({
      executor: { agent: "mimo", model: "mimo-native" },
    });
  });

  it("rejects unsupported Codex OpenAI-compatible providers until native materialization exists", () => {
    expect(() =>
      provisionRunnerLaunch({
        version: 1,
        runnerId: "codex-zai",
        adapter: "codex",
        capabilityAgent: "codex",
        model: "glm",
        provider: {
          kind: "openai_compatible",
          baseUrl: "https://api.z.ai/api/paas/v4",
          apiKeyEnv: "ZAI_API_KEY",
          wireApi: "responses",
        },
        permissionPolicy: "default",
      }),
    ).toThrow(SupervisorError);
  });
});
