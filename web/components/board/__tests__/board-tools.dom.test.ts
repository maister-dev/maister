// @vitest-environment jsdom

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
  usePathname: () => "/projects/fuse",
  useSearchParams: () => new URLSearchParams("tab=board"),
}));

import { BoardTools } from "@/components/board/board-tools";

let container: HTMLDivElement;
let root: Root;

function change(select: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function render(): void {
  const props: ComponentProps<typeof BoardTools> = {
    filters: { flow: "", agent: "", priority: "", touched: "" },
    labels: {
      filterFlow: "флоу",
      filterAgent: "агент",
      filterPrio: "приоритет",
      filterTouched: "изменено",
      filterAny: "любой",
      filterAnyTime: "за всё время",
      clearFilters: "Сбросить",
      layout: "вид",
      layoutBoard: "доска",
      layoutSwimlanes: "дорожки",
      layoutList: "список",
      asOf: "на",
      justNow: "только что",
    },
    options: {
      flow: [{ value: "review", label: "review" }],
      agent: [{ value: "codex", label: "codex" }],
      priority: [{ value: "urgent", label: "срочный" }],
      touched: [{ value: "7d", label: "за 7 дней" }],
    },
    children: createElement("div", { "data-board": true }),
  };

  act(() => {
    root.render(createElement(BoardTools, props));
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

describe("BoardTools filters", () => {
  it("renders four native selects instead of decorative buttons", () => {
    render();

    expect(container.querySelectorAll("select")).toHaveLength(4);
    expect(
      container.querySelector<HTMLSelectElement>('[name="board_touched"]')
        ?.value,
    ).toBe("");
    expect(container.textContent).toContain("за всё время");
  });

  it("writes filters to the URL without scrolling and composes rapid changes", () => {
    render();
    const flow = container.querySelector<HTMLSelectElement>(
      '[name="board_flow"]',
    );
    const priority = container.querySelector<HTMLSelectElement>(
      '[name="board_priority"]',
    );

    expect(flow).not.toBeNull();
    expect(priority).not.toBeNull();
    change(flow!, "review");
    change(priority!, "urgent");

    expect(replace).toHaveBeenNthCalledWith(
      1,
      "/projects/fuse?tab=board&board_flow=review",
      { scroll: false },
    );
    expect(replace).toHaveBeenNthCalledWith(
      2,
      "/projects/fuse?tab=board&board_flow=review&board_priority=urgent",
      { scroll: false },
    );
  });
});
