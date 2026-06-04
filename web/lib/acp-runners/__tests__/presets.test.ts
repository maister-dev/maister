import { describe, expect, it } from "vitest";

import {
  defaultPlatformRunnerId,
  platformRunnerPresetRows,
  routerSidecarPresetRows,
} from "@/lib/acp-runners/presets";

describe("platform ACP runner presets", () => {
  it("exposes the required Claude and Codex provider preset matrix", () => {
    const runners = platformRunnerPresetRows();

    expect(runners.map((runner) => runner.id)).toEqual([
      "claude-code",
      "claude-code-ccr",
      "claude-code-env-router",
      "claude-code-dangerous",
      "codex-openai",
      "codex-zai-glm",
      "codex-qwen",
    ]);
    expect(defaultPlatformRunnerId).toBe("claude-code");
    expect(runners.find((runner) => runner.id === "claude-code")).toMatchObject(
      {
        adapter: "claude",
        capabilityAgent: "claude",
        provider: { kind: "anthropic" },
        readinessStatus: "Ready",
      },
    );
    expect(
      runners.find((runner) => runner.id === "claude-code-dangerous"),
    ).toMatchObject({
      permissionPolicy: "dangerously_skip_permissions",
      readinessStatus: "Ready",
    });
    expect(
      runners.find((runner) => runner.id === "claude-code-env-router"),
    ).toMatchObject({
      provider: {
        kind: "anthropic_compatible",
        baseUrl: "https://api.z.ai/api/anthropic",
      },
      readinessStatus: "NotReady",
    });
    expect(
      runners.find((runner) => runner.id === "codex-openai"),
    ).toMatchObject({
      adapter: "codex",
      capabilityAgent: "codex",
      provider: { kind: "openai" },
      readinessStatus: "Ready",
    });
  });

  it("keeps unverified Codex OpenAI-compatible providers visible but NotReady", () => {
    const runners = platformRunnerPresetRows();

    for (const runnerId of ["codex-zai-glm", "codex-qwen"]) {
      const runner = runners.find((item) => item.id === runnerId);

      expect(runner).toMatchObject({
        adapter: "codex",
        provider: { kind: "openai_compatible" },
        readinessStatus: "NotReady",
      });
      expect(runner?.readinessReasons).toContain(
        "Codex OpenAI-compatible provider materialization is not verified",
      );
    }
  });

  it("exposes the managed CCR sidecar preset without raw secrets", () => {
    expect(routerSidecarPresetRows()).toEqual([
      expect.objectContaining({
        id: "ccr-default",
        authTokenRef: "env:MAISTER_CCR_AUTH_TOKEN",
        readinessStatus: "NotReady",
      }),
    ]);
  });
});
