import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/runs/run-1",
  useSearchParams: () => new URLSearchParams(),
}));

import { WorkbenchPanel } from "@/components/workbench/workbench-panel";

const labels = {
  files: "Files",
  diff: "Diff",
  evidence: "Evidence",
  timeline: "Timeline",
};

describe("WorkbenchPanel", () => {
  it("stretches the run files tree and viewer like the project repo viewer", () => {
    const html = renderToStaticMarkup(
      createElement(WorkbenchPanel, {
        runId: "run-1",
        tabLabels: labels,
        filesTree: createElement("div", { "data-testid": "file-tree" }),
        filesPane: createElement("div", { "data-testid": "code-view" }),
        diff: createElement("div", null, "Diff"),
      }),
    );

    expect(html).toContain('data-testid="files-pane"');
    expect(html).toContain("items-stretch");
    expect(html).toContain("min-h-[560px]");
    expect(html).toContain("[&amp;_[data-testid=code-view]]:!h-full");
    expect(html).toContain("[&amp;_[data-testid=code-view]]:!max-h-full");
  });
});
