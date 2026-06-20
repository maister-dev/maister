// M36 Phase 6 (ADR-095): render tests for the inspector "Spawned runs (N)"
// list. renderToStaticMarkup (no jsdom); labels passed as props. Asserts the
// data-* contract, status dot tone, the KEY-N vs as-run row, and the link.

import type { RunInspectorChildRun } from "@/components/runs/run-inspector-child-runs-list";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  RunInspectorChildRunsList,
  type RunInspectorChildRunsLabels,
} from "@/components/runs/run-inspector-child-runs-list";

const labels: RunInspectorChildRunsLabels = {
  title: (count: number) => `Spawned runs (${count})`,
  asRun: "(as-run)",
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

function render(childRuns: RunInspectorChildRun[]): string {
  return renderToStaticMarkup(
    createElement(RunInspectorChildRunsList, { childRuns, labels }),
  );
}

describe("RunInspectorChildRunsList", () => {
  it("renders the section with the localized title and count", () => {
    const html = render([
      { runId: "r1", status: "Running", taskRef: "TST-1" },
      { runId: "r2", status: "Done", taskRef: "TST-2" },
    ]);

    expect(html).toContain('data-testid="run-inspector-child-runs"');
    expect(html).toContain("Spawned runs (2)");
  });

  it("renders a child row with its status, task ref, and a link to the run", () => {
    const html = render([
      { runId: "r-xyz", status: "Review", taskRef: "TST-9" },
    ]);

    expect(html).toContain('data-child-run-id="r-xyz"');
    expect(html).toContain('data-run-status="Review"');
    expect(html).toContain('data-run-tone="review"');
    expect(html).toContain("TST-9");
    expect(html).toContain('data-as-run="false"');
    expect(html).toContain('href="/runs/r-xyz"');
  });

  it("renders the as-run fallback for a task-less child", () => {
    const html = render([{ runId: "r-3", status: "Running", taskRef: null }]);

    expect(html).toContain('data-as-run="true"');
    expect(html).toContain("(as-run)");
  });
});
