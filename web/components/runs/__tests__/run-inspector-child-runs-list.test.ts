// M37 Phase 6 (ADR-098): render tests for the inspector "Spawned runs (N)"
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
  // Pre-pluralized string (the caller counts; the component renders it verbatim).
  title: "Spawned runs (2)",
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

// ADR-165 AC-34 (the badge half): a child row carries the same result glyph
// vocabulary the run's own panel uses, so a fan-out reads at a glance.
describe("child result glyphs (ADR-165)", () => {
  const withResult: RunInspectorChildRunsLabels = {
    ...labels,
    resultStatus: {
      pending: "Pending",
      valid: "Valid",
      absent: "Absent",
      missing: "Missing",
      stale: "Stale",
      invalid: "Invalid",
      unavailable: "Unavailable",
    },
  };

  function render(
    children: RunInspectorChildRun[],
    withLabels = withResult,
  ): string {
    return renderToStaticMarkup(
      createElement(RunInspectorChildRunsList, {
        childRuns: children,
        labels: withLabels,
      }),
    );
  }

  it("renders NO glyph for a child with no result contract", () => {
    const html = render([
      { runId: "r1", status: "Done", taskRef: "KEY-1", resultStatus: null },
    ]);

    expect(html).not.toContain('data-testid="child-run-result-glyph"');
  });

  it("renders the glyph with an ACCESSIBLE NAME for each status", () => {
    for (const status of [
      "pending",
      "valid",
      "absent",
      "missing",
      "stale",
      "invalid",
      "unavailable",
    ] as const) {
      const html = render([
        { runId: "r1", status: "Done", taskRef: "KEY-1", resultStatus: status },
      ]);

      expect(html).toContain(`data-result-status="${status}"`);
      // Icon-only affordances MUST carry a name (web/CLAUDE.md).
      expect(html).toContain(
        `aria-label="${withResult.resultStatus![status]}"`,
      );
    }
  });

  it("renders no glyph when the caller supplies no result labels", () => {
    const html = render(
      [
        {
          runId: "r1",
          status: "Done",
          taskRef: "KEY-1",
          resultStatus: "valid",
        },
      ],
      labels,
    );

    expect(html).not.toContain('data-testid="child-run-result-glyph"');
  });
});
