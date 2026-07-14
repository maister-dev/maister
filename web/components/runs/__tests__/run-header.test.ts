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
  budgetWarn: "budget $pct%",
  review: "Review changes",
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

  it("renders the KEY-N chip as a link to the task page when taskHref is set", () => {
    const html = render({
      keyRef: "MAI-42",
      taskHref: "/projects/maister/tasks/42",
    });

    expect(html).toContain('data-testid="run-header-keyref"');
    expect(html).toContain('href="/projects/maister/tasks/42"');
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

  it("renders a project link above the run title when projectHref is set", () => {
    const html = render({
      projectHref: "/projects/maister",
      projectLabel: "← Back to board",
    });

    expect(html).toContain('data-testid="run-header-project-link"');
    expect(html).toContain('href="/projects/maister"');
    expect(html).toContain("← Back to board");
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

  it("links the header review affordance to the existing review surface", () => {
    const html = render({ reviewHref: "#review-panel" });

    expect(html).toContain('data-testid="run-header-review"');
    expect(html).toContain('href="#review-panel"');
  });
});

describe("RunHeader — budget warn badge (AC-BADGE-1)", () => {
  it("renders the amber budget badge with the consumed percent when warn", () => {
    const html = render({ budgetStatus: { warn: true, pct: 85 } });

    expect(html).toContain('data-testid="run-header-budget-warn"');
    expect(html).toContain("budget 85%");
  });

  it("omits the badge when the run is below the warn band", () => {
    const html = render({ budgetStatus: { warn: false, pct: 40 } });

    expect(html).not.toContain('data-testid="run-header-budget-warn"');
  });

  it("omits the badge when there is no budget signal (null)", () => {
    const html = render({ budgetStatus: null });

    expect(html).not.toContain('data-testid="run-header-budget-warn"');
  });
});

describe("RunHeader — PR-state chip (ADR-137)", () => {
  const prLabels: RunHeaderLabels = {
    ...labels,
    prChip: {
      open: "PR open",
      merged: "PR merged",
      closed: "PR closed",
      conflicts: "Conflicts",
      reopen: "Reopen",
    },
  };

  it("renders the merged PR chip in the header facts row", () => {
    const html = renderToStaticMarkup(
      createElement(RunHeader, {
        title: "t",
        status: "Done",
        inspectorOpen: false,
        labels: prLabels,
        prState: "merged",
        prHasConflicts: false,
      }),
    );

    expect(html).toContain('data-testid="pr-state-chip"');
    expect(html).toContain('data-pr-state="merged"');
  });

  it("omits the chip when prChip labels are absent (non-run-detail consumer)", () => {
    const html = render({ prState: "merged" });

    expect(html).not.toContain('data-testid="pr-state-chip"');
  });
});
