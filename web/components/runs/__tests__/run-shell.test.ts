import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  formatRunChangeSummary,
  RunHeader,
  type RunHeaderLabels,
} from "@/components/runs/run-header";
import { RunShell } from "@/components/runs/run-shell";

const LABELS: RunHeaderLabels = {
  branch: "Branch",
  changes: "Changes",
  changesUnavailable: "Unavailable",
  changedFiles: "files",
  openInspector: "Open inspector",
  closeInspector: "Close inspector",
};

describe("RunHeader", () => {
  it("formats compact change summaries", () => {
    expect(
      formatRunChangeSummary(
        { fileCount: 3, additions: 12, deletions: 5 },
        LABELS,
      ),
    ).toBe("3 files | +12 -5");
  });

  it("renders status, branch, target branch, and change size", () => {
    const html = renderToStaticMarkup(
      createElement(RunHeader, {
        title: "Run result",
        status: "Review",
        branch: "maister/run-1",
        targetBranch: "main",
        changeSummary: { fileCount: 2, additions: 4, deletions: 1 },
        inspectorOpen: true,
        labels: LABELS,
      }),
    );

    expect(html).toContain('data-testid="run-header-status"');
    expect(html).toContain("Review");
    expect(html).toContain("maister/run-1 -&gt; main");
    expect(html).toContain("2 files | +4 -1");
    expect(html).toContain("Close inspector");
  });
});

describe("RunShell", () => {
  it("renders the inspector by default with responsive shell classes", () => {
    const html = renderToStaticMarkup(
      createElement(
        RunShell,
        {
          title: "Run result",
          status: "Running",
          branch: "maister/run-1",
          labels: LABELS,
          inspector: createElement("div", null, "Inspector"),
        },
        createElement("div", null, "Main"),
      ),
    );

    expect(html).toContain('data-inspector-open="true"');
    expect(html).toContain('data-testid="run-shell-inspector"');
    expect(html).toContain("max-w-none");
    expect(html).toContain("min-w-[1000px]");
    expect(html).toContain("xl:grid-cols-[minmax(0,1fr)_380px]");
  });

  it("can start collapsed without rendering the inspector region", () => {
    const html = renderToStaticMarkup(
      createElement(
        RunShell,
        {
          title: "Run result",
          status: "Done",
          labels: LABELS,
          defaultInspectorOpen: false,
          inspector: createElement("div", null, "Inspector"),
        },
        createElement("div", null, "Main"),
      ),
    );

    expect(html).toContain('data-inspector-open="false"');
    expect(html).not.toContain('data-testid="run-shell-inspector"');
    expect(html).toContain("Open inspector");
  });
});
