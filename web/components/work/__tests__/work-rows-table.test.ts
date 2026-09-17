// The shared work row, asserted as MARKUP (ADR-174).
//
// `WorkRowsTable` has two consumers — `/work` and the Desk — and
// `WorkTableLabels extends WorkRowsLabels` so a column change is a compile error
// at both call sites rather than a blank header at one. These cases cover what
// the compiler cannot see: which cells actually render, and what a screen reader
// is given for the ones that changed shape.
//
// `renderToStaticMarkup` rather than a mounted render: none of this needs a DOM,
// and the node-environment `unit` project is the lane CI runs.

import type { WorkTableRow } from "@/lib/queries/work-table";
import type { WorkStage } from "@/lib/work/stage";

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { WorkRowsTable } from "@/components/work/work-rows-table";
import { buildWorkRowsLabels } from "@/lib/work/work-row-labels";
import { groupWorkTableRows } from "@/lib/work/work-table-view";

const NOW = new Date("2026-09-17T12:00:00.000Z");

// Distinguishable, greppable label strings — a real catalog would make an
// assertion pass for the wrong reason whenever two columns share copy.
const labels = buildWorkRowsLabels(
  (key) => `w:${key}`,
  (key) => `s:${key}`,
);

function row(over: Partial<WorkTableRow> = {}): WorkTableRow {
  return {
    taskId: "task-1",
    number: 1,
    keyRef: "MYAPP-1",
    title: "a task",
    projectId: "project-1",
    projectSlug: "myapp",
    projectName: "MyApp",
    stage: "Executing",
    blocked: false,
    promotedKind: null,
    progress: null,
    runId: "run-1",
    runStatus: null,
    readiness: null,
    waitingOn: null,
    blockers: [],
    tokens: 0,
    lastActivityAt: NOW,
    ...over,
  };
}

function render(
  rows: WorkTableRow[],
  groupBy: Parameters<typeof groupWorkTableRows>[1],
): string {
  return renderToStaticMarkup(
    createElement(WorkRowsTable, {
      groupBy,
      groups: groupWorkTableRows(rows, groupBy),
      labels,
      locale: "en",
      now: NOW,
    }),
  );
}

describe("T-D7 the project column is hidden by GROUPING, not by surface", () => {
  it("omits the project cell and header under project grouping", () => {
    const html = render([row()], "project");

    expect(html).not.toContain("w:columns.project");
    // The group heading names the project, so the cell would be the second
    // copy of a value the reader is already looking at.
    expect(html).not.toContain('href="/projects/myapp"');
    expect(html).toContain("MyApp");
  });

  it("renders the project cell under every other grouping", () => {
    for (const groupBy of ["none", "stage", "mine"] as const) {
      const html = render([row()], groupBy);

      expect(html, groupBy).toContain("w:columns.project");
      expect(html, groupBy).toContain('href="/projects/myapp"');
    }
  });
});

describe("T-D8 the stage chip carries the run-status refinement", () => {
  // `STAGE_BY_RUN_STATUS` is many-to-one: three run statuses collapse into
  // `WaitingOnHuman` and two into `Executing`. The raw-enum column carried that
  // distinction; removing it without moving the distinction would lose a live
  // session, a checkpoint and a manual takeover into one indistinguishable chip.
  const refinements: Array<[WorkStage, string, string]> = [
    ["WaitingOnHuman", "NeedsInput", "s:runNeedsInput"],
    ["WaitingOnHuman", "NeedsInputIdle", "s:runNeedsInputIdle"],
    ["WaitingOnHuman", "HumanWorking", "s:runHumanWorking"],
    ["Executing", "Running", "s:runRunning"],
    ["Executing", "WaitingOnChildren", "s:runWaitingOnChildren"],
  ];

  it("gives each collapsed run status a distinguishable accessible name", () => {
    const seen = new Set<string>();

    for (const [stage, runStatus, expected] of refinements) {
      const html = render(
        [row({ stage, runStatus: runStatus as WorkTableRow["runStatus"] })],
        "none",
      );

      expect(html, `${stage}/${runStatus}`).toContain(expected);
      seen.add(expected);
    }

    // Distinguishable is the point: five statuses that all rendered the same
    // string would satisfy every assertion above and still lose the data.
    expect(seen.size).toBe(refinements.length);
  });

  it("renders byte-identically when no run status is given", () => {
    // The negative case, and the one that matters most: `decision-card.tsx`,
    // `hitl-card.tsx` and `flight-card.tsx` all render this chip and pass no run
    // status. The refinement must be additive or it silently reshapes three
    // other surfaces.
    const withNull = render([row({ runStatus: null })], "none");
    const withUndefined = render(
      [row({ runStatus: undefined as unknown as null })],
      "none",
    );

    expect(withNull).toBe(withUndefined);
    for (const [, , label] of refinements) {
      expect(withNull).not.toContain(label);
    }
  });
});

describe("T-D9 the run stays reachable after its column is removed", () => {
  it("renders a named affordance for the run", () => {
    const html = render([row({ runId: "run-42" })], "none");

    expect(html).toContain('href="/runs/run-42"');
    // Icon-only controls MUST carry an accessible name (web/CLAUDE.md).
    expect(html).toMatch(/aria-label="w:openRun"|title="w:openRun"/u);
  });

  it("renders no run affordance for a task that never launched", () => {
    const html = render([row({ runId: null })], "none");

    expect(html).not.toContain("/runs/");
  });

  it("no longer renders a raw run-status column", () => {
    const html = render([row({ runStatus: "Running" })], "none");

    expect(html).not.toContain("w:columns.run");
  });
});

describe("T-D10 the next action is an affordance, and `none` is an em dash", () => {
  it("renders an em dash for a stage with no next action", () => {
    // `Promoted` and `Abandoned` map to `none`. A sentence there ("Nothing")
    // reads as a thing to do.
    const html = render([row({ stage: "Promoted" })], "none");

    expect(html).not.toContain("w:nextAction.none");
    expect(html).toContain("—");
  });

  it("renders the affordance for a stage that has one", () => {
    const html = render([row({ stage: "Review" })], "none");

    expect(html).toContain("w:nextAction.review");
  });
});

describe("T-D12 `/work` keeps the row it always had", () => {
  // The expansion is the Desk's, behind a prop defaulting to OFF (ADR-174 D5).
  // This is the guard that keeps it off here: `/work` and the Desk share one
  // component, so the cheapest way for the feature to leak is a default flip.
  //
  // Written in Phase 2, before the prop exists, deliberately — a negative
  // regression guard is worth most when it predates the thing it forbids.
  it("renders no expand affordance", () => {
    const html = render([row()], "none");

    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain('data-testid="work-row-panel"');
  });

  it("renders exactly one row element per row", () => {
    const html = render([row({ taskId: "a" }), row({ taskId: "b" })], "none");

    expect(html.split('data-testid="work-row"').length - 1).toBe(2);
  });
});
