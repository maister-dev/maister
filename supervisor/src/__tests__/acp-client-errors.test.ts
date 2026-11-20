import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { describe, expect, it } from "vitest";

import { classifyAcpMethodError } from "../acp-client";
import { SupervisorError } from "../types";

describe("classifyAcpMethodError", () => {
  it.each([
    [
      "claude",
      { errorKind: "invalid_request" },
      "Prompt is too long",
      "context_exhausted",
    ],
    [
      "claude",
      { errorKind: "max_output_tokens" },
      "Synthetic output limit",
      "max_output_tokens",
    ],
    [
      "codex",
      { codexErrorInfo: "contextWindowExceeded" },
      "Synthetic context limit",
      "context_exhausted",
    ],
    ["claude", { errorKind: "invalid_request" }, "Wrong model", undefined],
    [
      "codex",
      { codexErrorInfo: "sessionBudgetExceeded" },
      "Synthetic budget limit",
      undefined,
    ],
  ] as const)(
    "classifies %s terminal evidence %j",
    (adapter, data, message, reason) => {
      const error = classifyAcpMethodError({
        adapter,
        method: "prompt",
        err: RequestError.internalError(data, message),
      });

      expect(error.code).toBe("ACP_PROTOCOL");
      expect(error.details?.reason).toBe(reason);
    },
  );
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
