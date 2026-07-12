import { describe, expect, it } from "vitest";

import {
  clientCapabilitiesForAdapter,
  getAdapterRuntime,
  resolveResumeAction,
} from "../adapter-registry";

describe("adapter registry", () => {
  it("defines ACP launch argv for Gemini, OpenCode, and MiMo", () => {
    expect(getAdapterRuntime("gemini")).toMatchObject({
      defaultBinary: "gemini",
      defaultArgs: ["--acp"],
      binaryOverrideEnv: "MAISTER_ADAPTER_BINARY_GEMINI",
    });
    expect(getAdapterRuntime("opencode")).toMatchObject({
      defaultBinary: "opencode",
      defaultArgs: ["acp"],
      binaryOverrideEnv: "MAISTER_ADAPTER_BINARY_OPENCODE",
    });
    expect(getAdapterRuntime("mimo")).toMatchObject({
      defaultBinary: "mimo",
      defaultArgs: ["acp"],
      binaryOverrideEnv: "MAISTER_ADAPTER_BINARY_MIMO",
    });
  });

  it("uses explicit no-FS ACP client capabilities for every adapter", () => {
    for (const adapter of [
      "claude",
      "codex",
      "gemini",
      "opencode",
      "mimo",
    ] as const) {
      expect(clientCapabilitiesForAdapter(adapter)).toEqual({
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
      });
    }
  });

  it("declares read-only-session capability support for every adapter runtime", () => {
    for (const adapter of [
      "claude",
      "codex",
      "gemini",
      "opencode",
      "mimo",
    ] as const) {
      expect(getAdapterRuntime(adapter)).toMatchObject({
        readOnlyCapable: true,
      });
    }
    expect(getAdapterRuntime("claude").readOnlySessionSmoke).toBe(
      "not_required",
    );
    expect(getAdapterRuntime("codex").readOnlySessionSmoke).toBe(
      "not_required",
    );
    expect(getAdapterRuntime("gemini").readOnlySessionSmoke).toBe("required");
    expect(getAdapterRuntime("opencode").readOnlySessionSmoke).toBe("required");
    expect(getAdapterRuntime("mimo").readOnlySessionSmoke).toBe("required");
  });

  it("requires capability-enforcement smoke for every adapter runtime (ADR-130)", () => {
    for (const adapter of [
      "claude",
      "codex",
      "gemini",
      "opencode",
      "mimo",
    ] as const) {
      expect(getAdapterRuntime(adapter).capabilityEnforcementSmoke).toBe(
        "required",
      );
    }
  });

  it("selects adapter-aware resume behavior without falling back to newSession", () => {
    expect(
      resolveResumeAction("claude", {
        sessionCapabilities: { resume: true },
      }),
    ).toEqual({ kind: "resume_session" });
    expect(resolveResumeAction("codex", {})).toMatchObject({
      kind: "unsupported",
    });
    expect(
      resolveResumeAction("gemini", {
        sessionCapabilities: { load: true },
      }),
    ).toMatchObject({
      kind: "unsupported",
      reason: expect.stringContaining("Gemini loadSession"),
    });
    expect(resolveResumeAction("opencode", {})).toMatchObject({
      kind: "unsupported",
      reason: expect.stringContaining("opencode"),
    });
    expect(resolveResumeAction("mimo", {})).toMatchObject({
      kind: "unsupported",
      reason: expect.stringContaining("mimo"),
    });
  });
});
