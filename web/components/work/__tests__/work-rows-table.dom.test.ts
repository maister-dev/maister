// @vitest-environment jsdom

// `T-D13` (`AC-D13`) — a Desk row expands into its decision panel.
//
// Nothing in this repository expands a `<tr>`; `<details>` cannot wrap one. So
// this is new ground, and the interaction is the whole feature: a row that only
// expands by mouse, or that swallows the clicks meant for the links inside it,
// is worse than no expansion at all.
//
// jsdom rather than Playwright because this runs in CI. The layout half of the
// same feature — that the expanded cell still spans the full width at 390px —
// genuinely needs a viewport and stays in `desk.spec.ts`.

import type { WorkTableRow } from "@/lib/queries/work-table";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkRowsTable } from "@/components/work/work-rows-table";
import { buildWorkRowsLabels } from "@/lib/work/work-row-labels";
import { groupWorkTableRows } from "@/lib/work/work-table-view";

const NOW = new Date("2026-09-17T12:00:00.000Z");

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
    stage: "WaitingOnHuman",
    blocked: false,
    promotedKind: null,
    progress: null,
    runId: "run-1",
    runStatus: "NeedsInput",
    readiness: null,
    waitingOn: null,
    blockers: [],
    tokens: 0,
    lastActivityAt: NOW,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

function mount(rows: WorkTableRow[], expandable: boolean): void {
  act(() => {
    root.render(
      createElement(WorkRowsTable, {
        expandable,
        groupBy: "none",
        groups: groupWorkTableRows(rows, "none"),
        labels,
        locale: "en",
        now: NOW,
        panels: { "task-1": createElement("div", null, "PANEL BODY") },
      }),
    );
  });
}

function firstRow(): HTMLTableRowElement {
  const el = container.querySelector<HTMLTableRowElement>(
    'tr[data-testid="work-row"]',
  );

  if (el === null) throw new Error("no work row rendered");

  return el;
}

function panelRows(): number {
  return container.querySelectorAll('[data-testid="work-row-panel"]').length;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("T-D13 a Desk row expands into its panel", () => {
  it("expands on a click anywhere on the row", () => {
    mount([row()], true);

    const tr = firstRow();

    expect(tr.getAttribute("aria-expanded")).toBe("false");
    expect(panelRows()).toBe(0);

    act(() => {
      tr.click();
    });

    expect(tr.getAttribute("aria-expanded")).toBe("true");
    expect(panelRows()).toBe(1);
    expect(container.textContent).toContain("PANEL BODY");
  });

  for (const key of ["Enter", " "]) {
    it(`expands on ${key === " " ? "Space" : key}`, () => {
      mount([row()], true);

      const tr = firstRow();

      act(() => {
        tr.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      expect(tr.getAttribute("aria-expanded")).toBe("true");
      expect(panelRows()).toBe(1);
    });
  }

  it("collapses again on a second activation", () => {
    mount([row()], true);

    const tr = firstRow();

    act(() => {
      tr.click();
    });
    act(() => {
      tr.click();
    });

    expect(tr.getAttribute("aria-expanded")).toBe("false");
    expect(panelRows()).toBe(0);
  });

  it("does NOT toggle when a link inside the row is clicked", () => {
    mount([row()], true);

    const tr = firstRow();
    const link = tr.querySelector("a");

    expect(
      link,
      "the row carries links to the task and the run",
    ).not.toBeNull();

    act(() => {
      link?.click();
    });

    // The row must not swallow navigation. A reader clicking `MYAPP-1` wants the
    // task, not a panel — and getting both is the bug this forbids.
    expect(tr.getAttribute("aria-expanded")).toBe("false");
    expect(panelRows()).toBe(0);
  });

  it("is reachable from the keyboard", () => {
    mount([row()], true);

    expect(firstRow().tabIndex).toBe(0);
  });
});

describe("T-D13 expansion is opt-in", () => {
  it("renders an inert row when `expandable` is not set", () => {
    mount([row()], false);

    const tr = firstRow();

    expect(tr.getAttribute("aria-expanded")).toBeNull();
    expect(tr.tabIndex).toBe(-1);

    act(() => {
      tr.click();
    });

    expect(panelRows()).toBe(0);
  });
});
