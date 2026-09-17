// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// One translator instance per namespace: `tBoard` reaches `useCallback`/
// `useEffect` dependency arrays inside the editable field, and a fresh function
// per render turns those into an unbounded re-render loop.
vi.mock("next-intl", () => {
  const perNamespace = new Map<string, (key: string) => string>();

  return {
    useTranslations: (namespace: string) => {
      const cached = perNamespace.get(namespace);

      if (cached) return cached;

      const translate = (key: string): string => `${namespace}.${key}`;

      perNamespace.set(namespace, translate);

      return translate;
    },
  };
});

// TaskMarkdownEditor pulls tiptap in through `next/dynamic`, which has no
// Next.js runtime here. S2-d needs the editing branch to mount, not the editor.
vi.mock("@/components/social/task-markdown-editor", async () => {
  const React = await import("react");

  return {
    TaskMarkdownEditor: ({ value }: { value: string }) =>
      React.createElement("textarea", {
        "data-testid": "markdown-editor",
        readOnly: true,
        value,
      }),
  };
});

import { TaskCardDescription } from "@/components/board/task-card-description";

const SHORT = "**bold** short note";
const LONG = `## Heading\n\n${"word ".repeat(40)}`;

let root: Root;
let container: HTMLDivElement;
let consoleError: ReturnType<typeof vi.spyOn>;

function mount(prompt: string): void {
  act(() =>
    root.render(
      createElement(TaskCardDescription, {
        canEdit: true,
        prompt,
        slug: "demo",
        taskNumber: 7,
      }),
    ),
  );
}

function toggle(): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>("[aria-expanded]");

  if (!found) throw new Error("disclosure toggle not rendered");

  return found;
}

function clickLabelled(label: string): void {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );

  if (!found) throw new Error(`button not found: ${label}`);

  act(() => found.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  consoleError.mockRestore();
  vi.unstubAllGlobals();
});

describe("TaskCardDescription", () => {
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

  // S3: `renderView` runs inside the editable field's render body, and that
  // field returns early while editing. Hooks declared in the callback would be
  // skipped on the editing render and React would throw "Rendered fewer hooks
  // than expected" right here.
  it("S2-d survives entering and leaving edit mode from the expanded state", () => {
    mount(LONG);

    act(() => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    clickLabelled("board.editDescription");
    expect(
      container.querySelector("[data-testid=markdown-editor]"),
    ).not.toBeNull();

    clickLabelled("board.editCancel");

    expect(consoleError).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid=markdown-editor]")).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });
});
