import type { RunHeaderProps } from "@/components/runs/run-header";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RunHeader, type RunHeaderLabels } from "@/components/runs/run-header";

const labels: RunHeaderLabels = {
  branch: "Branch",
  changes: "Changes",
  changesUnavailable: "Unavailable",
  changedFiles: "files",
  openInspector: "Open inspector",
  closeInspector: "Close inspector",
  task: "Task",
};

function render(over: Partial<RunHeaderProps> = {}): string {
  return renderToStaticMarkup(
    createElement(RunHeader, {
      title: "Fix the flaky timeout",
      status: "Running",
      inspectorOpen: false,
      labels,
      ...over,
    }),
  );
}

describe("RunHeader — task-first header", () => {
  it("renders the task title as the H1", () => {
    const html = render({ title: "Fix the flaky timeout" });

    expect(html).toContain("<h1");
    expect(html).toContain("Fix the flaky timeout");
  });

  it("renders the KEY-N chip beside the status when keyRef is set", () => {
    const html = render({ keyRef: "MAI-42" });

    expect(html).toContain('data-testid="run-header-keyref"');
    expect(html).toContain("MAI-42");
  });

  it("omits the KEY-N chip for scratch runs (keyRef null)", () => {
    const html = render({ keyRef: null });

    expect(html).not.toContain('data-testid="run-header-keyref"');
  });

  it("renders the flow > node eyebrow from the subtitle", () => {
    const html = render({ subtitle: "bugfix › Implement fix" });

    expect(html).toContain('data-testid="run-header-eyebrow"');
    expect(html).toContain("bugfix");
    expect(html).toContain("Implement fix");
  });

  it("renders the collapsible Task block with the prompt as markdown", () => {
    const html = render({ taskPrompt: "Make the **timeout** configurable" });

    expect(html).toContain('data-testid="run-header-task"');
    expect(html).toContain("Task");
    // The prompt is rendered through MarkdownBody (bold -> <strong>).
    expect(html).toContain("<strong>timeout</strong>");
  });

  it("omits the Task block when there is no task prompt", () => {
    const html = render({ taskPrompt: null });

    expect(html).not.toContain('data-testid="run-header-task"');
  });

  it("still renders the branch line and change summary", () => {
    const html = render({
      branch: "maister/task-1/attempt-2",
      changeSummary: {
        fileCount: 3,
        additions: 12,
        deletions: 4,
      },
    });

    expect(html).toContain('data-testid="run-header-branch"');
    expect(html).toContain("maister/task-1/attempt-2");
    expect(html).toContain('data-testid="run-header-change-summary"');
  });
});
