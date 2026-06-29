import { describe, expect, it } from "vitest";

import { coalesceSessionUpdates } from "@/lib/run-transcript/coalesce";

function textChunk(text: string) {
  return {
    kind: "update" as const,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
    supervisorEventId: "0",
  };
}

describe("coalesceSessionUpdates", () => {
  it("coalesces streamed assistant text chunks into one message", () => {
    const messages = coalesceSessionUpdates([
      { ...textChunk("Hel"), supervisorEventId: "1" },
      { ...textChunk("lo"), supervisorEventId: "2" },
      { ...textChunk(" world"), supervisorEventId: "3" },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      sequence: 0,
      role: "assistant",
      content: "Hello world",
      supervisorEventId: "3",
    });
  });

  it("groups a tool_call and its tool_call_update into one tool row", () => {
    const messages = coalesceSessionUpdates([
      {
        kind: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "Read file",
          kind: "read",
          status: "pending",
          content: [],
        },
        supervisorEventId: "1",
      },
      {
        kind: "update",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
          content: [
            { type: "content", content: { type: "text", text: "done" } },
          ],
        },
        supervisorEventId: "2",
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("tool");
    const payload = JSON.parse(messages[0].content) as {
      status: string;
      result: string;
    };

    expect(payload.status).toBe("completed");
    expect(payload.result).toContain("done");
  });

  it("starts a new assistant message after a reset boundary", () => {
    const messages = coalesceSessionUpdates([
      { ...textChunk("before"), supervisorEventId: "1" },
      { kind: "reset" },
      { ...textChunk("after"), supervisorEventId: "2" },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe("before");
    expect(messages[1]).toMatchObject({ sequence: 1, content: "after" });
  });

  it("collapses usage into a single trailing system row", () => {
    const messages = coalesceSessionUpdates([
      { ...textChunk("hi"), supervisorEventId: "1" },
      {
        kind: "update",
        update: { sessionUpdate: "usage_update", used: 100, size: 200000 },
        supervisorEventId: "2",
      },
      {
        kind: "update",
        update: { sessionUpdate: "usage_update", used: 150, size: 200000 },
        supervisorEventId: "3",
      },
    ]);

    const usageRows = messages.filter((m) => {
      try {
        return (JSON.parse(m.content) as { kind?: string }).kind === "usage";
      } catch {
        return false;
      }
    });

    expect(usageRows).toHaveLength(1);
    expect(JSON.parse(usageRows[0].content)).toMatchObject({
      kind: "usage",
      used: 150,
    });
  });

  it("preserves order and assigns contiguous sequences", () => {
    const messages = coalesceSessionUpdates([
      { ...textChunk("a"), supervisorEventId: "1" },
      {
        kind: "update",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t",
          title: "x",
          status: "completed",
          content: [],
        },
        supervisorEventId: "2",
      },
      { ...textChunk("b"), supervisorEventId: "3" },
    ]);

    expect(messages.map((m) => m.sequence)).toEqual([0, 1, 2]);
    expect(messages.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
  });
});
