import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  GateChatTranscript,
  type ChatMessage,
  type GateChatLabels,
} from "@/components/runs/gate-chat-panel";

const labels: GateChatLabels = {
  title: "Ask the agent",
  placeholder: "Ask",
  send: "Send",
  sending: "Sending",
  unavailable: "Unavailable",
  idleCostWarning: "Cost warning",
  revertNotice: "Reverted",
  agentLabel: "Agent",
  error: "Failed",
  transcript: {
    thinking: "Thinking",
    rawEvent: "Raw event",
    input: "Input",
    result: "Result",
    copy: "copy",
    copied: "copied",
    toolCount: (name, count) => `${name} x${count}`,
  },
};

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: overrides.id ?? "m-1",
    role: overrides.role ?? "user",
    authorLabel: overrides.authorLabel ?? "Reviewer One",
    body: overrides.body ?? "Question?",
    seq: overrides.seq ?? 1,
    mutationReverted: overrides.mutationReverted ?? false,
    createdAt: overrides.createdAt ?? "2026-06-10T10:00:00.000Z",
  };
}

describe("GateChatTranscript", () => {
  it("renders gate chat with scratch transcript authors, timestamps, and assistant markdown", () => {
    const html = renderToStaticMarkup(
      createElement(GateChatTranscript, {
        labels,
        messages: [
          message({ id: "u-1", role: "user", body: "What changed?" }),
          message({
            id: "a-1",
            role: "agent",
            body: "Agent **reply**.",
            mutationReverted: true,
            seq: 2,
          }),
        ],
      }),
    );

    expect(html).toContain("Reviewer One");
    expect(html).toContain("Agent");
    expect(html).toContain("2026");
    expect(html).toContain("<strong>reply</strong>");
    expect(html).toContain('data-testid="gate-chat-revert-notice"');
  });
});
