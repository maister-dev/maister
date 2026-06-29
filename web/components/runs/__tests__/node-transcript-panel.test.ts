import type { TranscriptMessage } from "@/components/run-transcript/transcript-view";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  NodeTranscriptPanel,
  type NodeTranscriptPanelLabels,
  isLiveRunStatus,
  transcriptPanelDefaultOpen,
} from "@/components/runs/node-transcript-panel";

const labels: NodeTranscriptPanelLabels = {
  title: "Agent activity",
  empty: "No agent output yet.",
  thinking: "Thinking",
  rawEvent: "Raw event",
  input: "Input",
  result: "Result",
  copy: "Copy",
  copied: "Copied",
  toolCount: "{name} ×{count}",
};

function render(over: {
  defaultOpen: boolean;
  live: boolean;
  initialMessages?: TranscriptMessage[];
}): string {
  return renderToStaticMarkup(
    createElement(NodeTranscriptPanel, {
      runId: "run-1",
      nodeId: "implement",
      labels,
      ...over,
    }),
  );
}

describe("isLiveRunStatus", () => {
  it("treats terminal statuses as not live", () => {
    for (const s of ["Done", "Abandoned", "Failed", "Crashed"]) {
      expect(isLiveRunStatus(s)).toBe(false);
    }
  });

  it("treats in-flight statuses as live", () => {
    for (const s of ["Running", "NeedsInput", "Review", "HumanWorking"]) {
      expect(isLiveRunStatus(s)).toBe(true);
    }
  });
});

describe("transcriptPanelDefaultOpen", () => {
  it("opens only for the current node of a live run", () => {
    expect(transcriptPanelDefaultOpen(true, true)).toBe(true);
    expect(transcriptPanelDefaultOpen(true, false)).toBe(false);
    expect(transcriptPanelDefaultOpen(false, true)).toBe(false);
  });
});

describe("NodeTranscriptPanel render", () => {
  it("renders TranscriptView when messages are present and open", () => {
    const html = render({
      defaultOpen: true,
      live: false,
      initialMessages: [
        {
          id: "m1",
          role: "assistant",
          content: "Implemented the fix.",
          createdAt: "2026-06-29T00:00:00.000Z",
        },
      ],
    });

    expect(html).toContain('data-testid="node-transcript-panel"');
    expect(html).toContain("Implemented the fix.");
    expect(html).toContain('aria-expanded="true"');
  });

  it("shows the empty state when open with no messages", () => {
    const html = render({
      defaultOpen: true,
      live: false,
      initialMessages: [],
    });

    expect(html).toContain("No agent output yet.");
  });

  it("collapses (no transcript body) when defaultOpen is false", () => {
    const html = render({
      defaultOpen: false,
      live: true,
      initialMessages: [
        {
          id: "m1",
          role: "assistant",
          content: "hidden until expanded",
          createdAt: "2026-06-29T00:00:00.000Z",
        },
      ],
    });

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("hidden until expanded");
  });
});
