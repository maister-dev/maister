// ADR-151 — the renderer NEVER re-resolves a mention. It detects the
// write-time link shape structurally and draws a non-navigating chip: there is
// no `/agents/<id>` route, and `/agents` itself is admin-only, so a real link
// would 404 or 403 for the members who read these comments.
// renderToStaticMarkup — no jsdom (repo convention).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownBody } from "@/components/social/markdown-body";

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownBody, { text }));
}

describe("MarkdownBody agent-mention chip", () => {
  it("renders an expanded agent mention as a non-navigating chip", () => {
    const html = render("[@core:triager](/agents/core:triager) please look");

    expect(html).toContain("@core:triager");
    expect(html).toContain('title="core:triager"');
    expect(html).not.toContain('href="/agents/core:triager"');
    expect(html).not.toContain("<a");
  });

  it("leaves a task KEY-N link as a real link", () => {
    const html = render("[MAI-12](/projects/maister/tasks/12)");

    expect(html).toContain('href="/projects/maister/tasks/12"');
  });

  it("leaves an ordinary link alone", () => {
    const html = render("[docs](https://example.test/agents/x)");

    expect(html).toContain('href="https://example.test/agents/x"');
  });

  // The label must look like a mention: a hand-typed `[docs](/agents/x)` is a
  // link, not a chip.
  it("requires the @ label shape", () => {
    const html = render("[docs](/agents/core:triager)");

    expect(html).toContain("<a");
  });

  it("keeps a code-fenced mention as plain text", () => {
    const html = render("```\n@core:triager\n```");

    expect(html).not.toContain('title="core:triager"');
    expect(html).toContain("@core:triager");
  });
});
