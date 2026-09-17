// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { MarkdownBody } from "@/components/social/markdown-body";
import { markdownExcerpt } from "@/lib/markdown-excerpt";

// S1.1 states the rule the per-rule table in `markdown-excerpt.test.ts` can only
// sample: the excerpt MUST NOT strip a marker the expanded body renders, and
// MUST strip one it unwraps. Angle brackets are where that bites, because the
// two forms resolve in OPPOSITE directions — raw HTML stays literal (no
// rehype-raw, ADR-078 D10) while a CommonMark autolink loses its brackets.
// Pinning the two against hand-written strings would restate the bug's own
// assumption, so each case is asserted against what the renderer actually
// produces.

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderedText(text: string): string {
  const host = document.createElement("div");

  document.body.append(host);

  const root = createRoot(host);

  act(() => {
    root.render(createElement(MarkdownBody, { text, variant: "compact" }));
  });

  const out = (host.textContent ?? "").replace(/\s+/g, " ").trim();

  act(() => root.unmount());
  host.remove();

  return out;
}

const ANGLE_BRACKET_CORPUS = [
  "Wrap it in a <div> and ship",
  "Make it <b>bold</b> please",
  "Use Array<string> for the list",
  "Replace <TaskInlineEditableField /> with a plain link",
  "Fail if x < 5 and y > 3 in the loop",
  "Use Map<string, number> here",
  "See <https://example.com> now",
  "Ping <kaa@example.com> about it",
  "Mixed <div> and <https://example.com> together",
];

describe("markdownExcerpt parity with MarkdownBody", () => {
  it.each(ANGLE_BRACKET_CORPUS)(
    "an untruncated excerpt of %j reads exactly as the expanded body does",
    (source) => {
      expect(markdownExcerpt(source)).toEqual({
        text: renderedText(source),
        truncated: false,
      });
    },
  );
});
