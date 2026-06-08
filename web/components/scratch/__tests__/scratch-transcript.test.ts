// Render smoke test for the IDE-grade scratch transcript. Render-only via
// createElement + renderToStaticMarkup (no jsdom), mirroring
// components/runs/__tests__/raw-diff.test.ts. The vitest `unit` glob is
// `components/**/__tests__/**/*.test.ts` (NO .tsx), so this is a `.test.ts`.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ScratchTranscript,
  type TranscriptLabels,
  type TranscriptMessage,
} from "@/components/scratch/scratch-transcript";
import {
  encodeThoughtPayload,
  encodeToolPayload,
  encodeUsagePayload,
} from "@/lib/scratch-runs/transcript";

const labels: TranscriptLabels = {
  thinking: "Thinking",
  rawEvent: "Raw event",
  input: "Input",
  result: "Result",
  copy: "copy",
  copied: "copied",
  toolCount: (name, count) => `${name} x${count}`,
};

function render(messages: TranscriptMessage[], running = false): string {
  return renderToStaticMarkup(
    createElement(ScratchTranscript, { messages, labels, running }),
  );
}

function message(
  partial: Partial<TranscriptMessage> &
    Pick<TranscriptMessage, "role" | "content">,
): TranscriptMessage {
  return {
    id: partial.id ?? `${partial.role}-1`,
    role: partial.role,
    content: partial.content,
    createdAt: partial.createdAt ?? "2026-06-08T00:00:00.000Z",
  };
}

describe("ScratchTranscript render", () => {
  it("renders assistant markdown without leaking raw JSON", () => {
    const html = render([
      message({ role: "assistant", content: "Here is **bold** text." }),
    ]);

    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("sessionUpdate");
    expect(html).not.toContain("jsonrpc");
  });

  it("renders a tool badge with name and argument summary", () => {
    const html = render([
      message({
        role: "tool",
        content: encodeToolPayload({
          name: "Bash",
          toolKind: "execute",
          status: "completed",
          arg: "git status",
          rawInput: { command: "git status" },
          result: "clean",
        }),
      }),
    ]);

    expect(html).toContain("Bash");
    expect(html).toContain("git status");
    // collapsed by default → raw input/result not in initial markup
    expect(html).not.toContain("clean");
  });

  it("collapses a multi-tool group to count chips, hiding the rows", () => {
    const tool = (name: string, arg: string) =>
      message({
        id: `${name}-${arg}`,
        role: "tool",
        content: encodeToolPayload({
          name,
          toolKind: "other",
          status: "completed",
          arg,
          rawInput: { command: arg },
          result: "",
        }),
      });
    const html = render([
      tool("Bash", "git status"),
      tool("Glob", "*.ts"),
      tool("Glob", "*.tsx"),
    ]);

    // summary chips visible
    expect(html).toContain("Bash x1");
    expect(html).toContain("Glob x2");
    // rows collapsed by default → per-call args hidden until the group expands
    expect(html).not.toContain("git status");
    expect(html).not.toContain("*.ts");
  });

  it("auto-expands the active (last) tool group while the turn runs", () => {
    const tool = (name: string, arg: string) =>
      message({
        id: `${name}-${arg}`,
        role: "tool",
        content: encodeToolPayload({
          name,
          toolKind: "other",
          status: "completed",
          arg,
          rawInput: { command: arg },
          result: "",
        }),
      });
    const html = render(
      [tool("Bash", "git status"), tool("Glob", "*.ts")],
      true,
    );

    // running → last (only) group is expanded, so per-call args are visible
    expect(html).toContain("git status");
    expect(html).toContain("*.ts");
  });

  it("collapses thinking and hides legacy raw protocol frames", () => {
    const html = render([
      message({
        role: "system",
        content: encodeThoughtPayload("secret reasoning"),
      }),
      message({
        id: "legacy-1",
        role: "system",
        content: '{"jsonrpc":"2.0","id":0,"result":{}}',
      }),
    ]);

    expect(html).toContain("Thinking");
    expect(html).toContain("Raw event");
    // both are collapsed by default
    expect(html).not.toContain("secret reasoning");
    expect(html).not.toContain("jsonrpc");
  });

  it("keeps token usage out of the transcript body", () => {
    const html = render([
      message({ role: "system", content: encodeUsagePayload(100, 200) }),
    ]);

    expect(html).not.toContain("100");
    expect(html).not.toContain("200");
  });
});
