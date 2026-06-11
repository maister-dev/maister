import { describe, expect, it } from "vitest";

import { classifyAcpMethodError } from "../acp-client";
import { SupervisorError } from "../types";

describe("classifyAcpMethodError", () => {
  it("classifies auth and credential failures as EXECUTOR_UNAVAILABLE", () => {
    const err = classifyAcpMethodError({
      adapter: "gemini",
      method: "initialize",
      err: new Error("authentication required: missing API key"),
      sessionId: "sup-1",
    });

    expect(err.code).toBe("EXECUTOR_UNAVAILABLE");
    expect(err.message).toContain("adapter=gemini");
    expect(err.message).toContain("method=initialize");
  });

  it("classifies unsupported resume as CHECKPOINT", () => {
    const err = classifyAcpMethodError({
      adapter: "opencode",
      method: "resumeSession",
      err: new Error("method not found"),
      sessionId: "sup-2",
    });

    expect(err.code).toBe("CHECKPOINT");
    expect(err.message).toContain("adapter=opencode");
  });

  it("classifies protocol-shaped failures as ACP_PROTOCOL", () => {
    const err = classifyAcpMethodError({
      adapter: "codex",
      method: "newSession",
      err: new Error("protocol version mismatch"),
    });

    expect(err.code).toBe("ACP_PROTOCOL");
  });

  it("preserves existing SupervisorError instances", () => {
    const original = new SupervisorError("CHECKPOINT", "already classified");
    const err = classifyAcpMethodError({
      adapter: "claude",
      method: "resumeSession",
      err: original,
    });

    expect(err).toBe(original);
  });
});
