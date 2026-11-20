import type { TranscriptLabels } from "../transcript-view";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { expect, it } from "vitest";

import { TranscriptView } from "../transcript-view";

import en from "@/messages/en.json";

const labels: TranscriptLabels = {
  thinking: "Thinking",
  rawEvent: "Raw event",
  input: "Input",
  result: "Result",
  copy: "Copy",
  copied: "Copied",
  limitedPreview: (bytes) => `Limited preview of ${bytes} bytes`,
  fullContent: "Download full content",
  toolCount: (name, count) => `${name} ×${count}`,
};

it("preserves the full-content action on a bounded compaction summary", () => {
  const href =
    "/api/runs/run-1/transcript/messages/compaction-1?attempt=attempt-1";
  const html = renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: "en",
      messages: { contextUsage: en.contextUsage },
      timeZone: "UTC",
      // eslint-disable-next-line react-jsx/no-children-prop -- Provider props require children in the non-JSX renderer.
      children: createElement(TranscriptView, {
        labels,
        messages: [
          {
            id: "compaction-1",
            role: "system",
            createdAt: "2026-11-20T10:00:00.000Z",
            content: JSON.stringify({
              v: 1,
              kind: "compaction",
              status: "completed",
              summary: "Preview of the retained summary",
            }),
            preview: { originalBytes: 400_000, fullContentHref: href },
          },
        ],
      }),
    }),
  );

  expect(html).toContain("Preview of the retained summary");
  expect(html).toContain("Limited preview of 400000 bytes");
  expect(html).toContain(`href="${href}"`);
});
