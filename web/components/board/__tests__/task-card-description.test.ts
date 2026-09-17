// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

import { CollapsibleDescription } from "@/components/board/task-card-description";

const SHORT = "**bold** short note";
const LONG = `## Heading\n\n${"word ".repeat(40)}`;

let root: Root;
let container: HTMLDivElement;

function mount(text: string): void {
  act(() => root.render(createElement(CollapsibleDescription, { text })));
}

function toggle(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>("[aria-expanded]");

  if (!found) throw new Error("disclosure toggle not rendered");

  return found;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("CollapsibleDescription", () => {
  it("S2-a renders a short description as Markdown with no disclosure control", () => {
    mount(SHORT);

    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("[aria-expanded]")).toBeNull();
  });

  it("S2-b mounts a long description collapsed onto an excerpt", () => {
    mount(LONG);

    expect(container.querySelector("h2")).toBeNull();
    expect(container.textContent).toContain("…");

    const control = toggle();

    expect(control.getAttribute("aria-expanded")).toBe("false");
    expect(control.textContent).toContain("board.descriptionExpand");

    const controlled = control.getAttribute("aria-controls");

    expect(controlled).toBeTruthy();
    expect(container.querySelector(`#${controlled}`)).not.toBeNull();
  });

  it("S2-c expands to the full Markdown and collapses again", () => {
    mount(LONG);

    act(() => toggle().click());

    expect(container.querySelector("h2")?.textContent).toBe("Heading");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().textContent).toContain("board.descriptionCollapse");

    act(() => toggle().click());

    expect(container.querySelector("h2")).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });
});
