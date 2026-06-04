import { describe, expect, it } from "vitest";

import { evaluateRunnerReadiness } from "@/lib/acp-runners/readiness";

const diagnostics = {
  adapters: [
    { id: "claude", available: true },
    { id: "codex", available: true },
  ],
  envRefs: [
    { name: "ANTHROPIC_AUTH_TOKEN", present: true },
    { name: "ZAI_API_KEY", present: false },
  ],
  sidecars: [{ id: "ccr-default", state: "ready" }],
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
