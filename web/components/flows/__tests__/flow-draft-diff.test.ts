import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FlowDraftDiffText } from "@/components/flows/flow-draft-diff";

function render(diff: string): string {
  return renderToStaticMarkup(
    createElement(FlowDraftDiffText, { diff, emptyLabel: "No changes" }),
  );
}

describe("FlowDraftDiffText", () => {
  it("renders the empty state + label when there is no diff", () => {
    const html = render("");

    expect(html).toContain('data-testid="flow-draft-diff-empty"');
    expect(html).toContain("No changes");
    expect(html).not.toContain('data-testid="flow-draft-diff"');
  });

  it("renders the raw diff when there are changes", () => {
    const html = render("- prompt: OLD\n+ prompt: NEW");

    expect(html).toContain('data-testid="flow-draft-diff"');
    expect(html).toContain("prompt: NEW");
    expect(html).not.toContain('data-testid="flow-draft-diff-empty"');
  });
});
