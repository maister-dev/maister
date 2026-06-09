// M22 Phase 5 (T5.3, RED): failing render tests for the extracted RawDiff block.
//
// Contract (NOT yet built — RED on the missing import):
//   web/components/runs/raw-diff.tsx
//     export function RawDiff({ diff }: { diff: string }): ReactElement
//       = the exact M18 review-panel <pre …>{diff}</pre> block, moved out so the
//         review panel and the workbench share one raw-diff renderer (no syntax
//         highlighting — Phase 2).
//
// Render-only, no hooks/fetch → renderToStaticMarkup is deterministic. Mirrors
// components/run/__tests__/readiness-summary.test.ts (createElement +
// renderToStaticMarkup, no jsdom). The vitest `unit` glob is
// `components/**/__tests__/**/*.test.ts` (NO .tsx), so this is a `.test.ts`.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RawDiff } from "@/components/runs/raw-diff";

function render(diff: string): string {
  return renderToStaticMarkup(createElement(RawDiff, { diff }));
}

describe("RawDiff — raw diff <pre> block (M22 T5.3)", () => {
  it("renders the diff text inside a <pre>", () => {
    const html = render("diff --git a/file.txt b/file.txt\n+added line\n");

    expect(html).toContain("<pre");
    expect(html).toContain("+added line");
  });

  it("keeps the diff text inside the <pre>, not elsewhere", () => {
    const html = render("diff --git a/file.txt b/file.txt\n+added line\n");
    const pre = html.slice(html.indexOf("<pre"));

    expect(pre).toContain("+added line");
  });

  it("renders a <pre> even for an empty diff", () => {
    const html = render("");

    expect(html).toContain("<pre");
  });
});
