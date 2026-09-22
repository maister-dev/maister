// @vitest-environment jsdom

// ADR-178 D7 — the auto-apply filter bar. Every assertion pins an EXACT URL:
// a lenient `toContain` would pass while the bar silently dropped the period
// or the view, which is precisely the defect this pattern can introduce.
//
// jsdom rather than Playwright because this is the lane CI runs.

import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/observatory",
  useSearchParams: () => new URLSearchParams(),
}));

import { ObservatoryFilterBar } from "@/components/observatory/observatory-filter-bar";
import { ObservatoryFilterState } from "@/components/observatory/observatory-filter-state";
import { ObservatoryViews } from "@/components/observatory/observatory-views";
import { labelsForTest } from "@/components/observatory/__tests__/labels.fixture";
import { parseObservatorySearchParams } from "@/lib/observatory/filters";

const NOW = new Date("2026-06-05T12:00:00.000Z");
const labels = labelsForTest();

let container: HTMLDivElement;
let root: Root;

function render(params: Record<string, string> = {}, projects = true): void {
  const { current } = parseObservatorySearchParams(params, NOW);

  act(() => {
    // The pending-patch owner sits above the bar on both routes; composing
    // edits is its job, so the bar cannot be exercised without it.
    const props: ComponentProps<typeof ObservatoryFilterState> = {
      current,
      pathname: "/observatory",
      children: createElement(ObservatoryFilterBar, {
        current,
        labels,
        pathname: "/observatory",
        projectOptions: projects
          ? [{ slug: "maister", name: "MAIster" }]
          : undefined,
      }),
    };

    root.render(createElement(ObservatoryFilterState, props));
  });
}

/**
 * A genuinely fresh page, not just a re-render.
 *
 * Re-rendering the SAME bar with the same URL means "the round-trip has not
 * landed yet", which is a different state: the bar deliberately keeps an
 * uncommitted edit alive across it.
 */
function remount(): void {
  act(() => root.unmount());
  container.remove();
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
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
    remount();
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

  // A tab click no longer strands a committed value — it carries it (see the
  // shared-pending-patch suite below). This pins the case that REMAINS: a
  // navigation the bar did not build, such as Back or a drill-down link, which
  // lands a URL without the value. The text stays on screen, because the bar is
  // mounted once, and says it is not applied.
  it("keeps the text when a navigation the bar did not build drops it", () => {
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

    // ...and THEN a navigation the bar did not build lands without the nodeId.
    // Holding the draft only in the DOM loses the text here: the value change
    // remounts the field empty.
    render({ view: "harness" });

    expect(byName<HTMLInputElement>("nodeId").value).toBe("draft-node");
  });

  it("announces a draft the URL does not carry, and stops once it does", () => {
    render({ view: "quality" });

    const node = byName<HTMLInputElement>("nodeId");
    const hint = () =>
      container.querySelector(
        '[data-testid="observatory-filter-nodeId-uncommitted"]',
      );

    expect(hint()).toBeNull();

    act(() => {
      setValue(node, "draft-node");
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Typed, not committed: the field shows text the page is NOT filtered by.
    expect(hint()?.textContent).toBe(labels.uncommitted);
    expect(
      byName<HTMLInputElement>("nodeId").getAttribute("aria-describedby"),
    ).toBe("observatory-filter-nodeId-uncommitted");

    // Once the URL carries it, the value IS the filter and the hint goes.
    render({ view: "quality", nodeId: "draft-node" });

    expect(hint()).toBeNull();
    expect(
      byName<HTMLInputElement>("nodeId").getAttribute("aria-describedby"),
    ).toBeNull();
  });

  it("keeps announcing a draft a foreign navigation stranded", () => {
    render({ view: "quality" });

    const node = byName<HTMLInputElement>("nodeId");

    act(() => {
      setValue(node, "draft-node");
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() =>
      node.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );
    render({ view: "quality", nodeId: "draft-node" });
    // A navigation the bar did not build lands without the param — the text
    // survives (by design) and must say it is not applied.
    render({ view: "harness" });

    expect(byName<HTMLInputElement>("nodeId").value).toBe("draft-node");
    expect(
      container.querySelector(
        '[data-testid="observatory-filter-nodeId-uncommitted"]',
      )?.textContent,
    ).toBe(labels.uncommitted);
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

  // Two controls touched before the first round-trip lands. Every commit used
  // to be built from the SERVER `current`, so the second one overwrote the
  // first — and the first control, uncontrolled and re-keyed on a value that
  // never changed, went on displaying the choice the page had just discarded.
  it("composes a second change onto one still in flight", () => {
    render();

    // No re-render between these two: the server has not answered yet.
    change(byName<HTMLSelectElement>("runKind"), "scratch");
    expect(replace).toHaveBeenLastCalledWith(
      "/observatory?view=overview&windowDays=30&runKind=scratch",
      { scroll: false },
    );

    const preset = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === labels.period.preset7,
    );

    act(() => preset?.click());

    expect(replace).toHaveBeenLastCalledWith(
      "/observatory?view=overview&windowDays=7&runKind=scratch",
      { scroll: false },
    );
    // The control still shows what the reader picked, and now the URL agrees.
    expect(byName<HTMLSelectElement>("runKind").value).toBe("scratch");
  });

  it("composes a third change onto two still in flight", () => {
    render();

    change(byName<HTMLSelectElement>("runKind"), "agent");
    change(byName<HTMLSelectElement>("project"), "maister");
    change(byName<HTMLInputElement>("from"), "2026-05-01");
    change(byName<HTMLInputElement>("to"), "2026-05-31");

    expect(replace).toHaveBeenLastCalledWith(
      "/observatory?view=overview&from=2026-05-01&to=2026-05-31&runKind=agent&project=maister",
      { scroll: false },
    );
  });

  // Once the page the patch asked for has arrived, the patch is spent.
  it("stops replaying a patch the URL already carries", () => {
    render();
    change(byName<HTMLSelectElement>("runKind"), "scratch");

    // The round-trip lands...
    render({ runKind: "scratch" });
    // ...and the reader clears the kind again.
    change(byName<HTMLSelectElement>("runKind"), "all");

    expect(replace).toHaveBeenLastCalledWith(
      "/observatory?view=overview&windowDays=30",
      { scroll: false },
    );
  });

  // A drill-down link or Back replaces the state wholesale. Re-imposing the
  // filter the reader set a moment earlier would undo the link they clicked.
  it("drops the accumulated patch when the reader navigates elsewhere", () => {
    render();
    change(byName<HTMLSelectElement>("runKind"), "scratch");

    // A heatmap drill-down lands: a different view, no runKind.
    render({ view: "quality", nodeId: "checks" });
    change(byName<HTMLInputElement>("from"), "2026-05-01");

    expect(replace).toHaveBeenLastCalledWith(
      "/observatory?view=quality&windowDays=30&nodeId=checks",
      { scroll: false },
    );
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

// ADR-178 D7/D6. A view tab is a `<Link>`, and its href used to be built by the
// SERVER from a `current` that predates anything the reader just committed. Two
// clicks in one gesture — a period preset, then a tab — therefore lost the
// period, because the tab's href was written before the preset existed. The bar
// and the tabs now read one pending patch, so the href composes it.
describe("view tabs and the bar share the pending patch", () => {
  function renderNav(params: Record<string, string> = {}): void {
    const { current } = parseObservatorySearchParams(params, NOW);

    act(() => {
      const props: ComponentProps<typeof ObservatoryFilterState> = {
        current,
        pathname: "/observatory",
        children: [
          createElement(ObservatoryFilterBar, {
            key: "bar",
            current,
            labels,
            pathname: "/observatory",
            projectOptions: [{ slug: "maister", name: "MAIster" }],
          }),
          createElement(ObservatoryViews, {
            key: "views",
            current,
            labels,
            pathname: "/observatory",
          }),
        ],
      };

      root.render(createElement(ObservatoryFilterState, props));
    });
  }

  function tabHref(view: string): string {
    return (
      container
        .querySelector(`[data-testid="observatory-view-${view}"]`)
        ?.getAttribute("href") ?? "<<no tab>>"
    );
  }

  it("starts with tab hrefs that mirror the URL", () => {
    renderNav();

    expect(tabHref("harness")).toBe("/observatory?view=harness&windowDays=30");
  });

  it("carries a preset committed a moment earlier into every tab href", () => {
    renderNav();

    const preset = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === labels.period.preset7,
    );

    // No re-render after this: the server has not answered yet, which is
    // exactly when a tab click used to discard the preset.
    act(() => preset?.click());

    expect(tabHref("harness")).toBe("/observatory?view=harness&windowDays=7");
    expect(tabHref("cost")).toBe("/observatory?view=cost&windowDays=7");
  });

  it("carries a run kind and a project committed before the click", () => {
    renderNav();

    change(byName<HTMLSelectElement>("runKind"), "scratch");
    change(byName<HTMLSelectElement>("project"), "maister");

    expect(tabHref("cost")).toBe(
      "/observatory?view=cost&windowDays=30&runKind=scratch&project=maister",
    );
  });

  // The blur-then-tab sequence: clicking a tab blurs the field, which COMMITS.
  it("carries a text filter the tab click itself committed", () => {
    renderNav({ view: "quality" });

    const node = byName<HTMLInputElement>("nodeId");

    act(() => {
      setValue(node, "checks");
      node.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(tabHref("harness")).toBe(
      "/observatory?view=harness&windowDays=30&nodeId=checks",
    );
  });

  // Harness does not own the artifact pair (D7), so a pending artifact filter
  // must NOT ride along — the drop wins over the pending patch.
  it("still drops a pending filter the target view does not own", () => {
    renderNav({ view: "quality" });

    const artifact = byName<HTMLInputElement>("artifactKind");

    act(() => {
      setValue(artifact, "log");
      artifact.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(tabHref("quality")).toContain("artifactKind=log");
    expect(tabHref("harness")).toBe("/observatory?view=harness&windowDays=30");
  });

  it("stops carrying the patch once the round-trip lands", () => {
    renderNav();

    const preset = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === labels.period.preset7,
    );

    act(() => preset?.click());
    expect(tabHref("harness")).toBe("/observatory?view=harness&windowDays=7");

    // The server answers; the patch is spent, and the reader goes elsewhere.
    renderNav({ windowDays: "7" });
    renderNav({ view: "quality", nodeId: "from-a-drilldown" });

    expect(tabHref("harness")).toBe(
      "/observatory?view=harness&windowDays=30&nodeId=from-a-drilldown",
    );
  });
});
