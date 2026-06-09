import type { EditorValidationResult } from "@/lib/flows/editor/validation";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EditorValidationSummary } from "@/components/flows/editor-validation-summary";

const labels = { valid: "No issues", title: "Issues" };

function render(result: EditorValidationResult): string {
  return renderToStaticMarkup(
    createElement(EditorValidationSummary, {
      result,
      labels,
      onSelectNode: () => {},
    }),
  );
}

describe("EditorValidationSummary", () => {
  it("renders the valid state when there are no issues", () => {
    const html = render({ ok: true, issues: [] });

    expect(html).toContain('data-testid="editor-validation-ok"');
    expect(html).toContain("No issues");
    expect(html).not.toContain('data-testid="editor-validation-issues"');
  });

  it("renders each issue mapped to its node (and gate)", () => {
    const html = render({
      ok: false,
      issues: [
        {
          nodeId: "plan",
          path: "settings.thinkingEffort",
          message: "bad enum",
        },
        {
          nodeId: "review",
          gateId: "g1",
          path: "mode",
          message: "human_review must not be blocking",
        },
      ],
    });

    expect(html).toContain('data-testid="editor-validation-issues"');
    expect(html).toContain('data-testid="editor-issue-plan"');
    expect(html).toContain('data-testid="editor-issue-review:g1"');
    expect(html).toContain("bad enum");
    expect(html).toContain("human_review must not be blocking");
  });
});
