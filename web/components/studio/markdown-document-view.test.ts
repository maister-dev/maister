import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownDocumentView } from "@/components/studio/markdown-document-view";

const labels = {
  preview: "Preview",
  code: "Code",
  frontmatter: "Frontmatter",
  malformedFrontmatter: "Bad frontmatter",
};

describe("MarkdownDocumentView", () => {
  it("renders frontmatter separately in preview mode", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownDocumentView, {
        source: "---\nname: Demo\ndescription: Use this.\n---\n# Body\nText",
        path: "SKILL.md",
        mode: "preview",
        previewHref: "?file=SKILL.md",
        codeHref: "?file=SKILL.md&view=code",
        labels,
      }),
    );

    expect(html).toContain('data-testid="markdown-document-preview"');
    expect(html).toContain("Frontmatter");
    expect(html).toContain("Demo");
    expect(html).toContain("Body");
  });

  it("renders raw source in code mode", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownDocumentView, {
        source: "---\nname: Demo\n---\n# Body",
        path: "SKILL.md",
        mode: "code",
        previewHref: "?file=SKILL.md",
        codeHref: "?file=SKILL.md&view=code",
        labels,
      }),
    );

    expect(html).toContain('data-testid="markdown-document-code"');
    expect(html).toContain("---");
    expect(html).toContain("name: Demo");
  });
});
