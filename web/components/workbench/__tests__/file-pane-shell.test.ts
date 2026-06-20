// Render-only smoke test (createElement + renderToStaticMarkup, no jsdom).
// FilePaneShell takes labels as props (no next-intl), so no mock is needed.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FilePaneShell } from "@/components/workbench/file-pane-shell";

function render(): string {
  return renderToStaticMarkup(
    createElement(
      FilePaneShell,
      {
        path: "src/app.ts",
        content: "export const answer = 42;\n",
        labels: { copy: "Copy", copied: "Copied" },
      },
      createElement("div", { "data-testid": "code-view" }, "body"),
    ),
  );
}

describe("FilePaneShell", () => {
  it("renders the path, copy control, and the viewer body", () => {
    const html = render();

    expect(html).toContain('data-testid="file-pane-shell"');
    expect(html).toContain("flex h-full flex-col");
    expect(html).toContain('data-testid="file-copy-button"');
    expect(html).toContain("src/app.ts");
    // Initial (un-copied) state shows the copy label, not the copied label.
    expect(html).toContain("Copy");
    expect(html).not.toContain("Copied");
    // The server-rendered viewer body is passed through as children.
    expect(html).toContain('data-testid="code-view"');
  });
});
