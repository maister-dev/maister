import type { TranscriptMessage } from "@/components/run-transcript/transcript-view";
import type { NodeTranscriptPanelLabels } from "@/components/runs/node-transcript-panel";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentRunTranscript } from "@/components/runs/agent-run-transcript";

const labels: NodeTranscriptPanelLabels = {
  title: "Transcript",
  empty: "No transcript yet",
  thinking: "Thinking",
  rawEvent: "Raw",
  input: "Input",
  result: "Result",
  copy: "Copy",
  copied: "Copied",
  toolCount: "{name} ×{count}",
};

describe("AgentRunTranscript", () => {
  it("renders preloaded messages when open", () => {
    const messages: TranscriptMessage[] = [
      {
        id: "run-1:0",
        role: "assistant",
        content: "hello from the agent",
        createdAt: "",
      },
    ];
    const html = renderToStaticMarkup(
      createElement(AgentRunTranscript, {
        defaultOpen: true,
        initialMessages: messages,
        labels,
        live: false,
        runId: "run-1",
      }),
    );

    expect(html).toContain('data-testid="agent-run-transcript"');
    expect(html).toContain("hello from the agent");
    expect(html).not.toContain("No transcript yet");
  });

  it("shows the empty label when open with no messages", () => {
    const html = renderToStaticMarkup(
      createElement(AgentRunTranscript, {
        defaultOpen: true,
        initialMessages: [],
        labels,
        live: false,
        runId: "run-1",
      }),
    );

    expect(html).toContain("No transcript yet");
  });

  it("hides the transcript body when collapsed", () => {
    const html = renderToStaticMarkup(
      createElement(AgentRunTranscript, {
        defaultOpen: false,
        initialMessages: [
          {
            id: "run-1:0",
            role: "assistant",
            content: "collapsed-secret",
            createdAt: "",
          },
        ],
        labels,
        live: false,
        runId: "run-1",
      }),
    );

    expect(html).toContain("Transcript");
    expect(html).not.toContain("collapsed-secret");
  });
});
