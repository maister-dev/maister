import { describe, expect, it } from "vitest";

import { nativeDefaultRunnerByAdapter } from "@/lib/acp-runners/native-defaults";
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
      "gemini-cli",
      "opencode-native",
      "mimo-code-native",
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

  it("exposes Gemini, OpenCode, and MiMo presets as NotReady without changing the default", () => {
    const runners = platformRunnerPresetRows();

    expect(defaultPlatformRunnerId).toBe("claude-code");
    expect(runners.find((runner) => runner.id === "gemini-cli")).toMatchObject({
      adapter: "gemini",
      capabilityAgent: "gemini",
      provider: { kind: "google_gemini", apiKey: "env:GEMINI_API_KEY" },
      permissionPolicy: "default",
      readinessStatus: "NotReady",
    });
    expect(
      runners.find((runner) => runner.id === "gemini-cli")?.readinessReasons,
    ).toEqual(
      expect.arrayContaining([
        "GEMINI_API_KEY must be configured in supervisor environment",
        "Gemini ACP initialize/newSession and checkpoint smoke must be confirmed",
      ]),
    );
    expect(
      runners.find((runner) => runner.id === "opencode-native"),
    ).toMatchObject({
      adapter: "opencode",
      capabilityAgent: "opencode",
      provider: { kind: "agent_native" },
      permissionPolicy: "default",
      readinessStatus: "NotReady",
    });
    expect(
      runners.find((runner) => runner.id === "opencode-native")
        ?.readinessReasons,
    ).toContain(
      "OpenCode ACP stdio and writable-state smoke must be confirmed",
    );
    expect(
      runners.find((runner) => runner.id === "mimo-code-native"),
    ).toMatchObject({
      adapter: "mimo",
      capabilityAgent: "mimo",
      model: "mimo-native",
      provider: { kind: "agent_native" },
      permissionPolicy: "default",
      readinessStatus: "NotReady",
    });
    expect(
      runners.find((runner) => runner.id === "mimo-code-native")
        ?.readinessReasons,
    ).toContain(
      "MiMo Code ACP stdio and writable-state smoke must be confirmed",
    );
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

  it("maps every native default runner id (ADR-094) to a real preset row", () => {
    const presetIds = new Set(
      platformRunnerPresetRows().map((runner) => runner.id),
    );

    // reconcilePlatformRunners upserts these ids verbatim; a drift between the
    // map and the preset catalog would make the upsert a silent no-op.
    for (const runnerId of Object.values(nativeDefaultRunnerByAdapter)) {
      expect(presetIds.has(runnerId)).toBe(true);
    }
  });
});
