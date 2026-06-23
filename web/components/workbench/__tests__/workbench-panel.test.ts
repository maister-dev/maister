import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const navState = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/runs/run-1",
  useSearchParams: () => navState.searchParams,
}));

import { WorkbenchPanel } from "@/components/workbench/workbench-panel";

const labels = {
  files: "Files",
  diff: "Diff",
  evidence: "Evidence",
  timeline: "Timeline",
};

function tagWithTestId(html: string, testId: string): string {
  const match = html.match(
    new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`),
  );

  if (!match) throw new Error(`Missing ${testId} tag`);

  return match[0];
}

function renderPanel(
  options: {
    searchParams?: string;
    tabs?: readonly ["files", "diff"];
  } = {},
): string {
  navState.searchParams = new URLSearchParams(options.searchParams);

  return renderToStaticMarkup(
    createElement(WorkbenchPanel, {
      runId: "run-1",
      tabLabels: labels,
      filesTree: createElement("div", { "data-testid": "file-tree" }),
      filesPane: createElement("div", { "data-testid": "code-view" }),
      diff: createElement("div", null, "Diff"),
      evidence: createElement("div", null, "Evidence body"),
      timeline: createElement("div", null, "Timeline body"),
      tabs: options.tabs,
    }),
  );
}

describe("WorkbenchPanel", () => {
  it("stretches the run files tree and viewer like the project repo viewer", () => {
    const html = renderPanel();

    expect(html).toContain('data-testid="files-pane"');
    expect(html).toContain("items-stretch");
    expect(html).toContain("md:grid-cols-[minmax(220px,300px)_minmax(0,1fr)]");
    expect(html).toContain("min-h-[560px]");
    expect(html).toContain("min-w-0");
    expect(html).toContain("[&amp;_[data-testid=code-view]]:!h-full");
    expect(html).toContain("[&amp;_[data-testid=code-view]]:!max-h-full");
  });

  it("keeps scratch run files and diff collapsed by default", () => {
    const html = renderPanel({ tabs: ["files", "diff"] });

    expect(html.split('data-testid="workbench-disclosure"').length - 1).toBe(1);
    expect(tagWithTestId(html, "workbench-disclosure")).not.toContain("open");
    expect(html).toContain('href="/runs/run-1?wb=files"');
    expect(html).toContain('href="/runs/run-1?wb=diff"');
  });

  it("keeps flow run files and diff collapsed by default", () => {
    const html = renderPanel();

    expect(html).toContain('role="tablist"');
    expect(html).toContain("Timeline body");
    expect(tagWithTestId(html, "workbench-disclosure")).not.toContain("open");
  });

  it("opens the diff disclosure for a diff deep link", () => {
    const html = renderPanel({
      searchParams: "wb=diff",
    });

    expect(tagWithTestId(html, "workbench-disclosure")).toContain("open");
    expect(tagWithTestId(html, "files-pane")).toContain("hidden");
    expect(tagWithTestId(html, "diff-pane")).not.toContain("hidden");
    expect(tagWithTestId(html, "timeline-pane")).toContain("hidden");
  });

  it("opens the files disclosure for a file deep link", () => {
    const html = renderPanel({
      searchParams: "wb=files&file=web/app/page.tsx",
      tabs: ["files", "diff"],
    });

    expect(tagWithTestId(html, "workbench-disclosure")).toContain("open");
    expect(tagWithTestId(html, "files-pane")).not.toContain("hidden");
    expect(tagWithTestId(html, "diff-pane")).toContain("hidden");
  });
});
