// M22 Phase 5 (T5.4): render tests for the run workbench tab strip.
//
// ASYNC-vs-SYNC DECISION (flagged in the QA report — recommend SYNC):
//   project-tabs.tsx is an ASYNC Server Component (awaits getTranslations) and is
//   therefore NOT renderToStaticMarkup-safe. The M22 panel precedent
//   (integrations-panel.test.ts) pins only the PURE, sync, labels-as-props seam
//   and leaves the async i18n wrapper untested. We follow that: WorkbenchTabs is a
//   SYNC component taking a `labels` prop — the page (a Server Component)
//   resolves the i18n strings and passes them down. This keeps
//   the tab strip deterministic under renderToStaticMarkup. If the Implementor
//   instead makes WorkbenchTabs async (getTranslations), these tests must move to
//   the same pure-seam treatment as integrations-panel — but SYNC labels-as-props
//   is the recommended shape.
//
// Contract:
//   Renders 4 <Link role="tab"> tabs Timeline|Diff|Files|Evidence with
//   query-state preserving hrefs, aria-selected on the active one.
//
// Uses renderToStaticMarkup (no jsdom). next/link renders as a plain <a> under
// renderToStaticMarkup, so href + role + aria-selected are assertable directly.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkbenchTabs } from "@/components/workbench/workbench-tabs";

type Active = "files" | "diff" | "evidence" | "timeline";

const LABELS = {
  files: "Files",
  diff: "Diff",
  evidence: "Evidence",
  timeline: "Timeline",
};

function render(active: Active): string {
  return renderToStaticMarkup(
    createElement(WorkbenchTabs, { runId: "run-1", active, labels: LABELS }),
  );
}

function renderWithState(active: Active): string {
  return renderToStaticMarkup(
    createElement(WorkbenchTabs, {
      runId: "run-1",
      active,
      labels: LABELS,
      pathname: "/runs/run-1",
      searchParams:
        "node=review&scope=uncommitted&diffFile=src/app.ts&inspector=open",
    }),
  );
}

describe("WorkbenchTabs", () => {
  it("renders exactly four role='tab' tabs", () => {
    const html = render("diff");
    const count = html.split('role="tab"').length - 1;

    expect(count).toBe(4);
  });

  it("renders all tab labels", () => {
    const html = render("diff");

    expect(html).toContain("Files");
    expect(html).toContain("Diff");
    expect(html).toContain("Evidence");
    expect(html).toContain("Timeline");
  });

  it("links each tab to /runs/{runId}?wb=<tab>", () => {
    const html = render("diff");

    expect(html).toContain('href="/runs/run-1?wb=timeline"');
    expect(html).toContain('href="/runs/run-1?wb=diff"');
    expect(html).toContain('href="/runs/run-1?wb=files"');
    expect(html).toContain('href="/runs/run-1?wb=evidence"');
  });

  it("preserves unrelated run query-state while changing wb", () => {
    const html = renderWithState("diff");

    expect(html).toContain(
      'href="/runs/run-1?node=review&amp;scope=uncommitted&amp;diffFile=src%2Fapp.ts&amp;inspector=open&amp;wb=timeline"',
    );
    expect(html).toContain(
      'href="/runs/run-1?node=review&amp;scope=uncommitted&amp;diffFile=src%2Fapp.ts&amp;inspector=open&amp;wb=diff"',
    );
    expect(html).toContain(
      'href="/runs/run-1?node=review&amp;scope=uncommitted&amp;diffFile=src%2Fapp.ts&amp;inspector=open&amp;wb=files"',
    );
    expect(html).toContain(
      'href="/runs/run-1?node=review&amp;scope=uncommitted&amp;diffFile=src%2Fapp.ts&amp;inspector=open&amp;wb=evidence"',
    );
  });

  it("orders Timeline first because it is the default run landing tab", () => {
    const html = render("timeline");

    expect(html).toMatch(
      /href="\/runs\/run-1\?wb=timeline"[\s\S]*href="\/runs\/run-1\?wb=diff"[\s\S]*href="\/runs\/run-1\?wb=files"[\s\S]*href="\/runs\/run-1\?wb=evidence"/,
    );
  });

  it("keeps every tab link exactly once", () => {
    const html = render("diff");

    expect(html.split('href="/runs/run-1?wb=timeline"').length - 1).toBe(1);
    expect(html.split('href="/runs/run-1?wb=diff"').length - 1).toBe(1);
    expect(html.split('href="/runs/run-1?wb=files"').length - 1).toBe(1);
    expect(html.split('href="/runs/run-1?wb=evidence"').length - 1).toBe(1);
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

  it("moves aria-selected to the timeline tab when timeline is active", () => {
    const html = render("timeline");

    expect(html).toMatch(
      /href="\/runs\/run-1\?wb=timeline"[^>]*aria-selected="true"|aria-selected="true"[^>]*href="\/runs\/run-1\?wb=timeline"/,
    );
  });
});
