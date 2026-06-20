// M37 Phase 6 (ADR-098): render tests for the board decomposition group.
// renderToStaticMarkup (no jsdom); labels passed as props. Asserts the data-*
// contract, the per-child status dot/label, the KEY-N row + task link, and the
// no-run case.

import type { ChildTaskRef } from "@/lib/queries/board";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  TaskDecomposition,
  type TaskDecompositionLabels,
} from "@/components/board/task-decomposition";

const labels: TaskDecompositionLabels = {
  title: (count: number) => `Decomposition (${count})`,
  noRun: "no run",
  status: {
    Pending: "Pending",
    Running: "Running",
    NeedsInput: "Needs input",
    NeedsInputIdle: "Needs input · idle",
    HumanWorking: "Human working",
    WaitingOnChildren: "Waiting on children",
    Review: "Review",
    Crashed: "Crashed",
    Done: "Done",
    Abandoned: "Abandoned",
    Failed: "Failed",
  },
};

function child(over: Partial<ChildTaskRef> = {}): ChildTaskRef {
  return {
    taskId: "child-1",
    number: 12,
    keyRef: "TST-12",
    title: "Child work item",
    latestRunStatus: "Running",
    ...over,
  };
}

function render(childTasks: ChildTaskRef[]): string {
  return renderToStaticMarkup(
    createElement(TaskDecomposition, { childTasks, labels, slug: "proj" }),
  );
}

describe("TaskDecomposition", () => {
  it("renders the group with the localized title and count", () => {
    const html = render([child(), child({ taskId: "child-2", number: 13 })]);

    expect(html).toContain('data-testid="task-decomposition"');
    expect(html).toContain("Decomposition (2)");
  });

  it("renders a child mini-row with status dot/label, KEY-N, and a task link", () => {
    const html = render([
      child({
        taskId: "c-9",
        number: 9,
        keyRef: "TST-9",
        latestRunStatus: "Review",
      }),
    ]);

    expect(html).toContain('data-child-task-id="c-9"');
    expect(html).toContain('data-run-status="Review"');
    expect(html).toContain('data-run-tone="review"');
    expect(html).toContain("TST-9");
    expect(html).toContain('href="/projects/proj/tasks/9"');
    expect(html).toContain("Review");
  });

  it("shows the no-run label and pending tone for a child that has never run", () => {
    const html = render([child({ latestRunStatus: null })]);

    expect(html).toContain('data-run-status="none"');
    expect(html).toContain('data-run-tone="pending"');
    expect(html).toContain("no run");
  });
});
