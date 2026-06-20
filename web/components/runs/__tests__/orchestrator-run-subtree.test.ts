// M36 Phase 6 (ADR-095): render tests for the orchestrator run-tree subtree.
// Uses renderToStaticMarkup (no jsdom), mirroring
// components/board/__tests__/flow-graph-view.test.ts. Labels are passed as
// props (no next-intl provider); the test asserts the data-* contract, the
// run-status rendering, the KEY-N vs as-run cases, and the empty/no-children
// behavior.

import type { ChildRunRef } from "@/lib/queries/run";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  OrchestratorRunSubtree,
  type OrchestratorRunSubtreeLabels,
} from "@/components/runs/orchestrator-run-subtree";

const labels: OrchestratorRunSubtreeLabels = {
  title: (count: number) => `Child runs (${count})`,
  agent: "agent",
  asRun: "(as-run)",
  empty: "No child runs spawned yet.",
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

function child(over: Partial<ChildRunRef> = {}): ChildRunRef {
  return {
    runId: "run-child-1",
    status: "Running",
    currentStepId: "implement",
    taskNumber: 7,
    taskKey: "TST",
    taskTitle: "Child task",
    delegationAgentId: "agent:planner",
    launchMode: "auto",
    startedAt: new Date("2026-06-20T10:00:00.000Z"),
    endedAt: null,
    ...over,
  };
}

function render(childRuns: ChildRunRef[]): string {
  return renderToStaticMarkup(
    createElement(OrchestratorRunSubtree, { childRuns, labels }),
  );
}

describe("OrchestratorRunSubtree", () => {
  it("renders the subtree container with the localized title and child count", () => {
    const html = render([child(), child({ runId: "run-child-2" })]);

    expect(html).toContain('data-testid="orchestrator-run-subtree"');
    expect(html).toContain("Child runs (2)");
  });

  it("renders a child sub-node with the run-status data attribute, KEY-N ref, agent id, and a link", () => {
    const html = render([
      child({ runId: "run-abc", status: "NeedsInput", taskTitle: "Build X" }),
    ]);

    expect(html).toContain('data-child-run-id="run-abc"');
    expect(html).toContain('data-run-status="NeedsInput"');
    // KEY-N composed from taskKey + taskNumber.
    expect(html).toContain("TST-7");
    expect(html).toContain('data-as-run="false"');
    // The delegation target agent id is surfaced.
    expect(html).toContain("agent:planner");
    expect(html).toContain('href="/runs/run-abc"');
    // The localized status label is rendered.
    expect(html).toContain("Needs input");
  });

  it("renders the as-run fallback for a task-less child", () => {
    const html = render([
      child({ taskNumber: null, taskKey: null, taskTitle: null }),
    ]);

    expect(html).toContain('data-as-run="true"');
    expect(html).toContain("(as-run)");
  });

  it("colors the status dot by run-status tone (Crashed → crashed tone)", () => {
    const html = render([child({ status: "Crashed" })]);

    expect(html).toContain('data-run-status="Crashed"');
    expect(html).toContain('data-run-tone="crashed"');
  });

  it("renders the empty state when there are no children", () => {
    const html = render([]);

    expect(html).toContain('data-testid="orchestrator-run-subtree-empty"');
    expect(html).toContain("No child runs spawned yet.");
    expect(html).toContain("Child runs (0)");
  });
});
