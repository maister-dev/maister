import { describe, expect, it } from "vitest";

import { evaluateRunnerReadiness } from "@/lib/acp-runners/readiness";

const diagnostics = {
  adapters: [
    {
      id: "claude",
      available: true,
      smoke: {
        status: "not_required",
        reason: null,
        checkedAt: null,
        protocolVersion: null,
      },
    },
    {
      id: "codex",
      available: true,
      smoke: {
        status: "not_required",
        reason: null,
        checkedAt: null,
        protocolVersion: null,
      },
    },
    {
      id: "gemini",
      available: true,
      smoke: {
        status: "pending",
        reason: "gemini ACP compatibility smoke has not been cached",
        checkedAt: null,
        protocolVersion: null,
      },
    },
    {
      id: "opencode",
      available: true,
      smoke: {
        status: "pending",
        reason: "opencode ACP compatibility smoke has not been cached",
        checkedAt: null,
        protocolVersion: null,
      },
    },
    {
      id: "mimo",
      available: true,
      smoke: {
        status: "pending",
        reason: "mimo ACP compatibility smoke has not been cached",
        checkedAt: null,
        protocolVersion: null,
      },
    },
  ],
  envRefs: [
    { name: "ANTHROPIC_AUTH_TOKEN", present: true },
    { name: "GEMINI_API_KEY", present: true },
    { name: "GOOGLE_API_KEY", present: true },
    { name: "ZAI_API_KEY", present: false },
  ],
  sidecars: [{ id: "ccr-default", state: "ready" }],
} as const;

const smokeReadyDiagnostics = {
  ...diagnostics,
  adapters: diagnostics.adapters.map((adapter) =>
    adapter.id === "gemini" ||
    adapter.id === "opencode" ||
    adapter.id === "mimo"
      ? {
          ...adapter,
          smoke: {
            status: "ok" as const,
            reason: null,
            checkedAt: "2026-06-11T12:00:00.000Z",
            protocolVersion: 1,
          },
        }
      : adapter,
  ),
} as const;

describe("evaluateRunnerReadiness", () => {
  it("marks supported direct Claude and Codex runners ready", () => {
    expect(
      evaluateRunnerReadiness({
        runner: {
          adapter: "claude",
          capabilityAgent: "claude",
          enabled: true,
          permissionPolicy: "default",
          provider: { kind: "anthropic" },
        },
        diagnostics,
      }),
    ).toEqual({ status: "Ready", reasons: [] });

    expect(
      evaluateRunnerReadiness({
        runner: {
          adapter: "codex",
          capabilityAgent: "codex",
          enabled: true,
          permissionPolicy: "default",
          provider: { kind: "openai" },
        },
        diagnostics,
      }),
    ).toEqual({ status: "Ready", reasons: [] });
  });

  it("keeps supported Gemini, OpenCode, and MiMo runners NotReady until smoke is cached", () => {
    expect(
      evaluateRunnerReadiness({
        runner: {
          adapter: "gemini",
          capabilityAgent: "gemini",
          enabled: true,
          permissionPolicy: "default",
          provider: { kind: "google_gemini", apiKey: "env:GEMINI_API_KEY" },
        },
        diagnostics,
      }),
    ).toEqual({
      status: "NotReady",
      reasons: [
        "adapter smoke is not ready: gemini (gemini ACP compatibility smoke has not been cached)",
      ],
    });

    expect(
      evaluateRunnerReadiness({
        runner: {
          adapter: "opencode",
          capabilityAgent: "opencode",
          enabled: true,
          permissionPolicy: "default",
          provider: { kind: "agent_native" },
        },
        diagnostics,
      }),
    ).toEqual({
      status: "NotReady",
      reasons: [
        "adapter smoke is not ready: opencode (opencode ACP compatibility smoke has not been cached)",
      ],
    });

    expect(
      evaluateRunnerReadiness({
        runner: {
          adapter: "mimo",
          capabilityAgent: "mimo",
          enabled: true,
          permissionPolicy: "default",
          provider: { kind: "agent_native" },
        },
        diagnostics,
      }),
    ).toEqual({
      status: "NotReady",
      reasons: [
        "adapter smoke is not ready: mimo (mimo ACP compatibility smoke has not been cached)",
      ],
    });
  });

  it("marks Gemini, OpenCode, and MiMo runners Ready when smoke is cached", () => {
    expect(
      evaluateRunnerReadiness({
        runner: {
          adapter: "gemini",
          capabilityAgent: "gemini",
          enabled: true,
          permissionPolicy: "default",
          provider: { kind: "google_gemini", apiKey: "env:GEMINI_API_KEY" },
        },
        diagnostics: smokeReadyDiagnostics,
      }),
    ).toEqual({ status: "Ready", reasons: [] });

    expect(
      evaluateRunnerReadiness({
        runner: {
          adapter: "gemini",
          capabilityAgent: "gemini",
          enabled: true,
          permissionPolicy: "default",
          provider: { kind: "google_gemini" },
        },
        diagnostics: smokeReadyDiagnostics,
      }),
    ).toEqual({ status: "Ready", reasons: [] });

    expect(
      evaluateRunnerReadiness({
        runner: {
          adapter: "opencode",
          capabilityAgent: "opencode",
          enabled: true,
          permissionPolicy: "default",
          provider: { kind: "agent_native" },
        },
        diagnostics: smokeReadyDiagnostics,
      }),
    ).toEqual({ status: "Ready", reasons: [] });

    expect(
      evaluateRunnerReadiness({
        runner: {
          adapter: "mimo",
          capabilityAgent: "mimo",
          enabled: true,
          permissionPolicy: "default",
          provider: { kind: "agent_native" },
        },
        diagnostics: smokeReadyDiagnostics,
      }),
    ).toEqual({ status: "Ready", reasons: [] });
  });

  it("requires env refs for Anthropic-compatible providers", () => {
    const result = evaluateRunnerReadiness({
      runner: {
        adapter: "claude",
        capabilityAgent: "claude",
        enabled: true,
        permissionPolicy: "default",
        provider: {
          kind: "anthropic_compatible",
          authToken: "env:ZAI_API_KEY",
          baseUrl: "https://api.z.ai/api/anthropic",
        },
      },
      diagnostics,
    });

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain("env ref is missing: ZAI_API_KEY");
  });

  it("keeps direct Anthropic-compatible providers NotReady without env diagnostics", () => {
    const result = evaluateRunnerReadiness({
      runner: {
        adapter: "claude",
        capabilityAgent: "claude",
        enabled: true,
        permissionPolicy: "default",
        provider: {
          kind: "anthropic_compatible",
          authToken: "env:ZAI_API_KEY",
          baseUrl: "https://api.z.ai/api/anthropic",
        },
      },
    });

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain(
      "adapter diagnostics are unavailable: claude",
    );
    expect(result.reasons).toContain(
      "env diagnostics are unavailable for: ZAI_API_KEY",
    );
  });

  it("requires adapter diagnostics for direct runners", () => {
    const result = evaluateRunnerReadiness({
      runner: {
        adapter: "claude",
        capabilityAgent: "claude",
        enabled: true,
        permissionPolicy: "default",
        provider: { kind: "anthropic" },
      },
    });

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain(
      "adapter diagnostics are unavailable: claude",
    );
  });

  it("requires a provider env ref for direct Anthropic-compatible providers", () => {
    const result = evaluateRunnerReadiness({
      runner: {
        adapter: "claude",
        capabilityAgent: "claude",
        enabled: true,
        permissionPolicy: "default",
        provider: {
          kind: "anthropic_compatible",
          baseUrl: "https://api.z.ai/api/anthropic",
        },
      },
      diagnostics,
    });

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain(
      "anthropic-compatible provider requires auth token env ref",
    );
  });

  it("keeps Codex OpenAI-compatible providers NotReady until materialization exists", () => {
    const result = evaluateRunnerReadiness({
      runner: {
        adapter: "codex",
        capabilityAgent: "codex",
        enabled: true,
        permissionPolicy: "default",
        provider: {
          kind: "openai_compatible",
          apiKey: "env:ZAI_API_KEY",
          baseUrl: "https://api.z.ai/api/paas/v4",
          wireApi: "responses",
        },
      },
      diagnostics,
    });

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain(
      "Codex OpenAI-compatible provider materialization is not verified",
    );
  });

  it("requires env refs for direct Gemini API providers", () => {
    const result = evaluateRunnerReadiness({
      runner: {
        adapter: "gemini",
        capabilityAgent: "gemini",
        enabled: true,
        permissionPolicy: "default",
        provider: {
          kind: "google_gemini",
          apiKey: "env:MISSING_GEMINI_API_KEY",
        },
      },
      diagnostics,
    });

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain(
      "env ref is missing: MISSING_GEMINI_API_KEY",
    );
  });

  it("allows Google Vertex readiness with only an API-key env ref", () => {
    const result = evaluateRunnerReadiness({
      runner: {
        adapter: "gemini",
        capabilityAgent: "gemini",
        enabled: true,
        permissionPolicy: "default",
        provider: {
          kind: "google_vertex",
          apiKey: "env:GOOGLE_API_KEY",
        },
      },
      diagnostics: smokeReadyDiagnostics,
    });

    expect(result).toEqual({ status: "Ready", reasons: [] });
  });

  it("requires ready sidecar diagnostics for CCR runners", () => {
    const result = evaluateRunnerReadiness({
      runner: {
        adapter: "claude",
        capabilityAgent: "claude",
        enabled: true,
        permissionPolicy: "default",
        provider: { kind: "anthropic_compatible" },
        sidecarId: "ccr-default",
      },
      diagnostics: {
        ...diagnostics,
        sidecars: [{ id: "ccr-default", state: "idle" }] as const,
      },
      sidecar: { id: "ccr-default", enabled: true, readinessStatus: "Ready" },
    });

    expect(result.status).toBe("NotReady");
    expect(result.reasons).toContain("sidecar ccr-default is not ready: idle");
  });
});
