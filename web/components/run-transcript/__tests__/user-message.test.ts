import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { expect, it } from "vitest";

import { TranscriptView } from "../transcript-view";

import en from "@/messages/en.json";

const labels = {
  thinking: "Thinking",
  rawEvent: "Raw",
  input: "Input",
  result: "Result",
  copy: "Copy",
  copied: "Copied",
  toolCount: (name: string, count: number) => `${name} ${count}`,
  deliveryBadge: () => "Queued",
};

function render(
  messages: {
    id: string;
    content: string;
    role: "user" | "assistant";
    createdAt: string;
    delivery?: "queued";
  }[],
): string {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: "en",
      messages: en,
      timeZone: "UTC",
      // eslint-disable-next-line react-jsx/no-children-prop -- Non-JSX server renderer.
      children: createElement(TranscriptView, {
        messages,
        labels,
        renderAttachments: () => createElement("span", null, "attachment"),
      }),
    }),
  );
}
it("closes long USER text with a four-line preview and independent full copy", () => {
  const html = render([
    {
      id: "long",
      content: "<unsafe>" + "x".repeat(2001),
      role: "user",
      createdAt: "2026-11-20T10:00:00Z",
      delivery: "queued",
    },
  ]);

  expect(html).toContain("line-clamp-4");
  expect(html).toContain("Show fully (2009 chars)");
  expect(html).toContain(">Copy</button>");
  expect(html).not.toContain('open=""');
  expect(html).toContain("attachment");
  expect(html).toContain("Queued");
  expect(html).toContain("&lt;unsafe&gt;");
});
it("keeps repeat metadata and anchor without another preview", () => {
  const html = render(
    ["first", "second"].map((id) => ({
      id,
      content: "x".repeat(2001),
      role: "user",
      createdAt: "",
    })),
  );

  expect(html).toContain("Sent again, unchanged");
  expect(html).toContain('data-transcript-message-id="second"');
  expect(html.match(/line-clamp-4/g)).toHaveLength(1);
});
it("leaves short USER markup and assistant rendering unchanged", () => {
  const html = render([
    { id: "short", content: "hello", role: "user", createdAt: "" },
    {
      id: "assistant",
      content: "**answer**",
      role: "assistant",
      createdAt: "",
    },
  ]);

  expect(html).not.toContain("<details");
  expect(html).toContain(
    'class="whitespace-pre-wrap break-words text-[13px] leading-[1.55]">hello</p>',
  );
  expect(html).toContain("<strong>answer</strong>");
  expect(html.match(/>Copy<\/button>/g)).toHaveLength(1);
});
