// @vitest-environment jsdom

// ADR-177 D7 — the auto-apply filter bar. Every assertion pins an EXACT URL:
// a lenient `toContain` would pass while the bar silently dropped the period
// or the view, which is precisely the defect this pattern can introduce.
//
// jsdom rather than Playwright because this is the lane CI runs.

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/observatory",
  useSearchParams: () => new URLSearchParams(),
}));

import { ObservatoryFilterBar } from "@/components/observatory/observatory-filter-bar";
import { labelsForTest } from "@/components/observatory/__tests__/labels.fixture";
import { parseObservatorySearchParams } from "@/lib/observatory/filters";

const NOW = new Date("2026-06-05T12:00:00.000Z");
const labels = labelsForTest();

let container: HTMLDivElement;
let root: Root;

function render(params: Record<string, string> = {}, projects = true): void {
  const { current } = parseObservatorySearchParams(params, NOW);

  act(() => {
    root.render(
      createElement(ObservatoryFilterBar, {
        current,
        labels,
        pathname: "/observatory",
        projectOptions: projects
          ? [{ slug: "maister", name: "MAIster" }]
          : undefined,
      }),
    );
  });
}

function byName<T extends HTMLElement>(name: string): T {
  const element = container.querySelector<T>(`[name="${name}"]`);

  if (!element) throw new Error(`no control named ${name}`);

  return element;
}

function setValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;

  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
}

function change(element: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    setValue(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  replace.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ObservatoryFilterBar", () => {
  it("has no Apply button and no form submit", () => {
    render();

    expect(container.querySelector("form")).toBeNull();
    expect(
      container.querySelector('button[type="submit"], input[type="submit"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Apply");
  });

  it("commits a preset click and drops any custom range", () => {
    render({ from: "2026-05-01", to: "2026-05-31" });

    const preset = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === labels.period.preset7,
    );

    expect(preset).toBeDefined();
    act(() => preset?.click());

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(
      "/observatory?view=overview&windowDays=7",
      { scroll: false },
    );
  });

  it("marks the active preset with aria-pressed", () => {
    render({ windowDays: "90" });

    const pressed = [...container.querySelectorAll("button")]
      .filter((button) => button.getAttribute("aria-pressed") === "true")
      .map((button) => button.textContent);

    expect(pressed).toEqual([labels.period.preset90]);
  });

  it("keeps the preset for a half-entered range and commits the pair once complete", () => {
    render();

    // D1 drops a half range, so the first pick cannot change the window yet —
    // but the typed value must survive for the second pick to complete it.
    change(byName<HTMLInputElement>("from"), "2026-05-01");
    expect(replace).toHaveBeenLastCalledWith(
      "/observatory?view=overview&windowDays=30",
      { scroll: false },
    );

    change(byName<HTMLInputElement>("to"), "2026-05-31");
    expect(replace).toHaveBeenLastCalledWith(
      "/observatory?view=overview&from=2026-05-01&to=2026-05-31",
      { scroll: false },
    );
  });

  it("clearing a date removes its param", () => {
    render({ from: "2026-05-01", to: "2026-05-31" });

    change(byName<HTMLInputElement>("from"), "");

    expect(replace).toHaveBeenCalledWith(
      "/observatory?view=overview&windowDays=30",
      { scroll: false },
    );
  });

  it("commits a run-kind change and clears back to all", () => {
    render();
    change(byName<HTMLSelectElement>("runKind"), "scratch");

    expect(replace).toHaveBeenCalledWith(
      "/observatory?view=overview&windowDays=30&runKind=scratch",
      { scroll: false },
    );

    render({ runKind: "scratch" });
    change(byName<HTMLSelectElement>("runKind"), "all");

    expect(replace).toHaveBeenLastCalledWith(
      "/observatory?view=overview&windowDays=30",
      { scroll: false },
    );
  });

  it("commits a project change on the portfolio and omits the select elsewhere", () => {
    render();
    change(byName<HTMLSelectElement>("project"), "maister");

    expect(replace).toHaveBeenCalledWith(
      "/observatory?view=overview&windowDays=30&project=maister",
      { scroll: false },
    );

    render({}, false);
    expect(container.querySelector('[name="project"]')).toBeNull();
  });

  it("commits free text on blur and on Enter, never on a keystroke", () => {
    render({ view: "quality" });

    const node = byName<HTMLInputElement>("nodeId");

    act(() => {
      setValue(node, "che");
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(replace).not.toHaveBeenCalled();

    act(() => {
      setValue(node, "checks");
      node.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(replace).toHaveBeenCalledWith(
      "/observatory?view=quality&windowDays=30&nodeId=checks",
      { scroll: false },
    );

    replace.mockClear();
    render({ view: "quality" });

    const flow = byName<HTMLInputElement>("flowId");

    act(() => {
      setValue(flow, "aif");
      flow.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(replace).toHaveBeenCalledWith(
      "/observatory?view=quality&windowDays=30&flowId=aif",
      { scroll: false },
    );
  });

  it("keeps the text across the blur-then-view-switch sequence a tab click causes", () => {
    render({ view: "quality" });

    const node = byName<HTMLInputElement>("nodeId");

    act(() => {
      setValue(node, "draft-node");
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(replace).not.toHaveBeenCalled();

    // Clicking a view tab BLURS the field first, which commits...
    act(() =>
      node.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );
    expect(replace).toHaveBeenCalledWith(
      "/observatory?view=quality&windowDays=30&nodeId=draft-node",
      { scroll: false },
    );
    render({ view: "quality", nodeId: "draft-node" });

    // ...and THEN the tab's own href lands, built by the server before that
    // commit existed, so it carries no nodeId. Holding the draft only in the
    // DOM loses the text here: the value change remounts the field empty.
    render({ view: "harness" });

    expect(byName<HTMLInputElement>("nodeId").value).toBe("draft-node");
  });

  it("yields to a value that arrived from somewhere else", () => {
    render({ view: "quality" });

    const node = byName<HTMLInputElement>("nodeId");

    act(() => {
      setValue(node, "mine");
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(byName<HTMLInputElement>("nodeId").value).toBe("mine");

    // A heatmap drill-down sets the node this bar never committed — the URL
    // is the state, so it wins and the stale draft goes.
    render({ view: "quality", nodeId: "from-a-drilldown" });

    expect(byName<HTMLInputElement>("nodeId").value).toBe("from-a-drilldown");
  });

  it("does not re-commit a blur that changed nothing", () => {
    render({ view: "quality", nodeId: "checks" });

    const node = byName<HTMLInputElement>("nodeId");

    act(() =>
      node.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );

    expect(replace).not.toHaveBeenCalled();
  });

  it("shows the drill-down fields only on the views that own them", () => {
    render({ view: "overview" });
    expect(container.querySelector('[name="flowId"]')).toBeNull();
    expect(container.querySelector('[name="artifactKind"]')).toBeNull();

    render({ view: "harness" });
    expect(container.querySelector('[name="flowId"]')).not.toBeNull();
    expect(container.querySelector('[name="artifactKind"]')).toBeNull();

    render({ view: "quality" });
    expect(container.querySelector('[name="flowId"]')).not.toBeNull();
    expect(container.querySelector('[name="artifactKind"]')).not.toBeNull();
  });

  it("preserves the current view in every commit", () => {
    render({ view: "cost" });
    change(byName<HTMLSelectElement>("runKind"), "agent");

    expect(replace).toHaveBeenCalledWith(
      "/observatory?view=cost&windowDays=30&runKind=agent",
      { scroll: false },
    );
  });

  it("starts not busy and exposes an aria-live pending slot", () => {
    render();

    const bar = container.querySelector(
      '[data-testid="observatory-filter-bar"]',
    );

    expect(bar?.getAttribute("aria-busy")).toBe("false");
    expect(
      container
        .querySelector('[data-testid="observatory-filter-pending"]')
        ?.getAttribute("aria-live"),
    ).toBe("polite");
  });

  it("renders the clamped notice only for a clamped period", () => {
    render();
    expect(container.textContent).not.toContain(labels.period.clamped);

    render({ from: "2024-01-01", to: "2026-06-04" });
    expect(container.textContent).toContain(labels.period.clamped);
  });

  it("gives every control a label", () => {
    render({ view: "quality" });

    for (const control of container.querySelectorAll("input, select")) {
      expect(
        control.closest("label"),
        control.getAttribute("name") ?? "",
      ).not.toBeNull();
    }
    // The preset group is a fieldset with its own legend.
    expect(container.querySelector("fieldset > legend")?.textContent).toBe(
      labels.period.label,
    );
  });
});
