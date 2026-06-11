import { describe, expect, it } from "vitest";

import {
  clientCapabilitiesForAdapter,
  getAdapterRuntime,
  resolveResumeAction,
} from "../adapter-registry";

describe("adapter registry", () => {
  it("defines ACP launch argv for Gemini and OpenCode", () => {
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
  });

  it("uses explicit no-FS ACP client capabilities for every adapter", () => {
    for (const adapter of ["claude", "codex", "gemini", "opencode"] as const) {
      expect(clientCapabilitiesForAdapter(adapter)).toEqual({
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
      });
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
  });
});
