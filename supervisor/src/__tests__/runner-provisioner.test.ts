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
