// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => router,
}));

import {
  BrainMemorySearch,
  projectBrainSearchHref,
} from "@/components/brain/brain-memory-search";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function mount(): HTMLDivElement {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);

  act(() => {
    root.render(
      createElement(BrainMemorySearch, {
        action: "Search",
        placeholder: "Search memory",
        query: "",
        slug: "demo project",
      }),
    );
  });

  return container;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;

  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(async () => {
  router.replace.mockReset();

  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
});

describe("BrainMemorySearch", () => {
  it("updates the query through client navigation without a native submit", () => {
    const container = mount();
    const form = container.querySelector<HTMLFormElement>(
      '[data-testid="brain-memory-search"]',
    );
    const input = form?.querySelector<HTMLInputElement>(
      'input[name="brain_query"]',
    );

    expect(form).not.toBeNull();
    expect(input).not.toBeNull();
    setInputValue(input as HTMLInputElement, "architecture & memory");

    const submitEvent = new Event("submit", {
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      form?.dispatchEvent(submitEvent);
    });

    expect(submitEvent.defaultPrevented).toBe(true);
    expect(router.replace).toHaveBeenCalledWith(
      "/projects/demo%20project?tab=brain&brain_query=architecture+%26+memory",
      { scroll: false },
    );
  });

  it("omits an empty query from the client-navigation URL", () => {
    expect(projectBrainSearchHref("demo", "   ")).toBe(
      "/projects/demo?tab=brain",
    );
  });
});
