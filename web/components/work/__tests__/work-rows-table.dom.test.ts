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

/** Mounted AND shown. The panel stays mounted once opened, so presence alone
 *  stopped being the question the moment it started holding a response form. */
function shownPanels(): number {
  return container.querySelectorAll(
    '[data-testid="work-row-panel"]:not([hidden])',
  ).length;
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
    expect(shownPanels()).toBe(1);
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
      expect(shownPanels()).toBe(1);
    });
  }

  it("collapses without unmounting the panel", () => {
    // The panel carries the HITL response form. Conditionally unmounting it
    // would throw away a half-typed answer on an accidental collapse, which is
    // why the project's rule is mount-once-then-`hidden`.
    mount([row()], true);

    const tr = firstRow();

    act(() => {
      tr.click();
    });

    const opened = container.querySelector('[data-testid="work-row-panel"]');

    act(() => {
      tr.click();
    });

    expect(tr.getAttribute("aria-expanded")).toBe("false");
    expect(shownPanels(), "hidden, not removed").toBe(0);
    expect(panelRows(), "still mounted").toBe(1);
    expect(
      container.querySelector('[data-testid="work-row-panel"]'),
      "the SAME element, so its form state survived",
    ).toBe(opened);
  });

  it("does not toggle when the click ends a text selection", () => {
    // Copying a task title out of the table must not open a panel.
    mount([row()], true);

    const tr = firstRow();
    const selection = globalThis.getSelection();

    selection?.removeAllRanges();

    const range = document.createRange();

    range.selectNodeContents(tr);
    selection?.addRange(range);

    act(() => {
      tr.click();
    });

    expect(tr.getAttribute("aria-expanded")).toBe("false");
    expect(panelRows()).toBe(0);

    selection?.removeAllRanges();
  });

  it("associates the row with the panel it controls", () => {
    mount([row()], true);

    const tr = firstRow();

    // Before the first expand the panel row does not exist yet, so advertising
    // `aria-controls` would point a screen reader at a missing id.
    expect(tr.getAttribute("aria-controls")).toBeNull();

    act(() => {
      tr.click();
    });

    const controls = tr.getAttribute("aria-controls");

    expect(controls).toBeTruthy();
    expect(
      container.querySelector(`#${controls}`)?.getAttribute("data-testid"),
      "aria-controls points at the panel row",
    ).toBe("work-row-panel");
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

  it("is reachable from the keyboard before it is operable by it", () => {
    // Focusability is the precondition for the Enter/Space cases above: without
    // it they would pass on a control no keyboard user can ever reach.
    mount([row()], true);

    const tr = firstRow();

    expect(tr.tabIndex).toBe(0);
    tr.focus();
    expect(document.activeElement).toBe(tr);
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

describe("T-D11 the panel cell spans the FULL column count", () => {
  // The invariant the responsive columns make dangerous, and the one clause of
  // `AC-D11` that had no test at any layer. Column hiding is CSS-driven, so the
  // `<td>` elements stay in the DOM; a `colSpan` derived from what is PAINTED
  // would under-span exactly at the widths where columns drop, and the expanded
  // panel would sit under part of the row instead of all of it.
  //
  // jsdom applies no stylesheet, so "visible column count" is not observable
  // here — which is precisely why the value must be derived from the full set
  // rather than measured. The 390px rendering half lives in `desk.spec.ts`.
  function panelCell(): HTMLTableCellElement {
    const cell = container.querySelector<HTMLTableCellElement>(
      '[data-testid="work-row-panel"] td',
    );

    if (cell === null) throw new Error("no panel cell rendered");

    return cell;
  }

  function headerCount(): number {
    return container.querySelectorAll("thead th").length;
  }

  it("spans every column the header renders, ungrouped", () => {
    mount([row()], true);
    act(() => {
      firstRow().click();
    });

    expect(panelCell().colSpan).toBe(headerCount());
  });

  it("drops exactly one span when the project column is not rendered", () => {
    // Under project grouping the project cell is conditionally rendered — NOT
    // CSS-hidden — so it genuinely leaves the DOM and the span must follow it
    // down by one. This is the case a blanket "always the full count" would get
    // wrong in the other direction.
    act(() => {
      root.render(
        createElement(WorkRowsTable, {
          expandable: true,
          groupBy: "project",
          groups: groupWorkTableRows([row()], "project"),
          labels,
          locale: "en",
          now: NOW,
          panels: { "task-1": createElement("div", null, "PANEL BODY") },
        }),
      );
    });
    act(() => {
      firstRow().click();
    });

    expect(panelCell().colSpan).toBe(headerCount());
  });
});
