import { describe, expect, it } from "vitest";

import { extractLastAgentMessage } from "@/lib/queries/inbox-context";

function ev(sessionUpdate: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "session.update",
    update: { sessionUpdate, ...extra },
  });
}

function msg(text: string): string {
  return ev("agent_message_chunk", { content: { text } });
}

function toolCall(id: string): string {
  return ev("tool_call", {
    toolCallId: id,
    kind: "execute",
    status: "pending",
    rawInput: {},
  });
}

describe("extractLastAgentMessage", () => {
  it("returns null when there is no agent message", () => {
    expect(extractLastAgentMessage("")).toBeNull();
    expect(extractLastAgentMessage(toolCall("t1"))).toBeNull();
  });

  it("coalesces consecutive agent_message_chunk text", () => {
    const log = [msg("Hello "), msg("world")].join("\n");

    expect(extractLastAgentMessage(log)).toBe("Hello world");
  });

  it("returns only the trailing message after the last tool call", () => {
    const log = [msg("first answer"), toolCall("t1"), msg("final answer")].join(
      "\n",
    );

    expect(extractLastAgentMessage(log)).toBe("final answer");
  });

  it("ignores blank lines, malformed JSON, and non-update events", () => {
    const log = [
      "",
      "{ not json",
      JSON.stringify({ type: "session.exited" }),
      msg("ok"),
    ].join("\n");

    expect(extractLastAgentMessage(log)).toBe("ok");
  });

  it("caps an overly long message with an ellipsis", () => {
    const out = extractLastAgentMessage(msg("x".repeat(1500)));

    expect(out).toHaveLength(1001);
    expect(out?.endsWith("…")).toBe(true);
  });
});
