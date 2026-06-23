import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TaskMarkdownEditor } from "@/components/social/task-markdown-editor";

const labels = {
  visual: "Visual",
  source: "Markdown",
  loading: "Loading editor.",
  empty: "Start writing.",
  textarea: "Description",
  toolbar: {
    undo: "Undo",
    redo: "Redo",
    heading1: "Heading 1",
    heading2: "Heading 2",
    quote: "Quote",
    bold: "Bold",
    italic: "Italic",
    inlineCode: "Inline code",
    codeBlock: "Code block",
    bulletList: "Bullet list",
    numberedList: "Numbered list",
    link: "Link",
    linkPrompt: "Link URL",
    divider: "Divider",
  },
};

describe("TaskMarkdownEditor", () => {
  it("renders visual and markdown source controls", () => {
    const html = renderToStaticMarkup(
      createElement(TaskMarkdownEditor, {
        labels,
        value: "**Hello**",
        onChange: () => {},
      }),
    );

    expect(html).toContain("Visual");
    expect(html).toContain("Markdown");
    expect(html).toContain('aria-label="Bold"');
    expect(html).toContain('aria-label="Bullet list"');
  });
});
