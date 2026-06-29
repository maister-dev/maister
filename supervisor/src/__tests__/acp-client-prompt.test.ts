import type { Logger } from "pino";

import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import { sendPromptOnConnection } from "../acp-client";

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function fakeConn(
  promptSpy: ReturnType<typeof vi.fn>,
): acp.ClientSideConnection {
  return { prompt: promptSpy } as unknown as acp.ClientSideConnection;
}

// T5.4 A: the supervisor forwards structured content blocks verbatim when the
// web tier supplies them, and falls back to wrapping the plain string into a
// single text block otherwise (verbatim-forward invariant preserved).
describe("sendPromptOnConnection — content blocks vs string", () => {
  it("forwards provided content blocks verbatim", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });
    const contentBlocks = [
      { type: "text", text: "review these" },
      { type: "resource_link", uri: "file:///x/n.txt", name: "n.txt" },
    ] as unknown as acp.ContentBlock[];

    await sendPromptOnConnection(
      fakeConn(prompt),
      {
        adapter: "claude",
        acpSessionId: "s1",
        stepId: "scratch-dialog",
        prompt: "review these",
        contentBlocks,
      },
      fakeLogger(),
    );

    expect(prompt).toHaveBeenCalledWith({
      sessionId: "s1",
      prompt: contentBlocks,
    });
  });

  it("wraps the string prompt into a single text block when no content is given", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });

    await sendPromptOnConnection(
      fakeConn(prompt),
      {
        adapter: "claude",
        acpSessionId: "s1",
        stepId: "step",
        prompt: "hello",
      },
      fakeLogger(),
    );

    expect(prompt).toHaveBeenCalledWith({
      sessionId: "s1",
      prompt: [{ type: "text", text: "hello" }],
    });
  });

  it("ignores an empty content array and wraps the string", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "end_turn" });

    await sendPromptOnConnection(
      fakeConn(prompt),
      {
        adapter: "claude",
        acpSessionId: "s1",
        stepId: "step",
        prompt: "hello",
        contentBlocks: [],
      },
      fakeLogger(),
    );

    expect(prompt).toHaveBeenCalledWith({
      sessionId: "s1",
      prompt: [{ type: "text", text: "hello" }],
    });
  });
});

// Interrupt (session/cancel): a `cancelled` stop reason throws ACP_PROTOCOL by
// default (unexpected abort → crash), but is returned verbatim when the caller
// flags it as an operator-requested cancel (the session stays live).
describe("sendPromptOnConnection — cancelled stop reason", () => {
  const baseArgs = {
    adapter: "claude" as const,
    acpSessionId: "s1",
    stepId: "step",
    prompt: "hello",
  };

  it("throws ACP_PROTOCOL on cancelled without a user-cancel flag", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "cancelled" });

    await expect(
      sendPromptOnConnection(fakeConn(prompt), baseArgs, fakeLogger()),
    ).rejects.toMatchObject({ code: "ACP_PROTOCOL" });
  });

  it("returns the cancelled response when the cancel was user-requested", async () => {
    const prompt = vi.fn().mockResolvedValue({ stopReason: "cancelled" });

    const resp = await sendPromptOnConnection(
      fakeConn(prompt),
      { ...baseArgs, isUserCancel: () => true },
      fakeLogger(),
    );

    expect(resp.stopReason).toBe("cancelled");
  });
});
