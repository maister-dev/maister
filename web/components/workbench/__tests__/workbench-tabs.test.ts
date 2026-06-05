// M22 Phase 5 (T5.4, RED): failing render tests for the workbench Files|Diff|Graph
// tab strip.
//
// ASYNC-vs-SYNC DECISION (flagged in the QA report — recommend SYNC):
//   project-tabs.tsx is an ASYNC Server Component (awaits getTranslations) and is
//   therefore NOT renderToStaticMarkup-safe. The M22 panel precedent
//   (integrations-panel.test.ts) pins only the PURE, sync, labels-as-props seam
//   and leaves the async i18n wrapper untested. We follow that: WorkbenchTabs is a
//   SYNC component taking a `labels` prop ({files, diff, graph}) — the page (a
//   Server Component) resolves the i18n strings and passes them down. This keeps
//   the tab strip deterministic under renderToStaticMarkup. If the Implementor
//   instead makes WorkbenchTabs async (getTranslations), these tests must move to
//   the same pure-seam treatment as integrations-panel — but SYNC labels-as-props
//   is the recommended shape.
//
// Contract (NOT yet built — RED on the missing import):
//   web/components/workbench/workbench-tabs.tsx exports
//     export function WorkbenchTabs({
//       runId, active, labels,
//     }: {
//       runId: string;
//       active: "files" | "diff" | "graph";
//       labels: { files: string; diff: string; graph: string };
//     }): ReactElement
//   Renders 3 <Link role="tab"> tabs Files|Diff|Graph with
//     href={`/runs/${runId}?wb=<tab>`}, aria-selected on the active one
//   (mirror project-tabs.tsx Link-based `?param=` convention).
//
// Uses renderToStaticMarkup (no jsdom). next/link renders as a plain <a> under
// renderToStaticMarkup, so href + role + aria-selected are assertable directly.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkbenchTabs } from "@/components/workbench/workbench-tabs";

type Active = "files" | "diff" | "graph";

const LABELS = { files: "Files", diff: "Diff", graph: "Graph" };

function render(active: Active): string {
  return renderToStaticMarkup(
    createElement(WorkbenchTabs, { runId: "run-1", active, labels: LABELS }),
  );
}

describe("WorkbenchTabs — Files|Diff|Graph workbench tabs (M22 T5.4)", () => {
  it("renders exactly three role='tab' tabs", () => {
    const html = render("diff");
    const count = html.split('role="tab"').length - 1;

    expect(count).toBe(3);
  });

  it("renders all three tab labels", () => {
    const html = render("diff");

    expect(html).toContain("Files");
    expect(html).toContain("Diff");
    expect(html).toContain("Graph");
  });

  it("links each tab to /runs/{runId}?wb=<tab>", () => {
    const html = render("diff");

    expect(html).toContain('href="/runs/run-1?wb=files"');
    expect(html).toContain('href="/runs/run-1?wb=diff"');
    expect(html).toContain('href="/runs/run-1?wb=graph"');
  });

  it("marks the active tab with aria-selected='true'", () => {
    const html = render("diff");

    // The active (diff) tab is selected.
    expect(html).toMatch(
      /href="\/runs\/run-1\?wb=diff"[^>]*aria-selected="true"|aria-selected="true"[^>]*href="\/runs\/run-1\?wb=diff"/,
    );
  });

  it("marks exactly one tab selected at a time", () => {
    const html = render("files");
    const selectedCount = html.split('aria-selected="true"').length - 1;

    expect(selectedCount).toBe(1);
  });

  it("moves aria-selected to the graph tab when graph is active", () => {
    const html = render("graph");

    expect(html).toMatch(
      /href="\/runs\/run-1\?wb=graph"[^>]*aria-selected="true"|aria-selected="true"[^>]*href="\/runs\/run-1\?wb=graph"/,
    );
  });
});
