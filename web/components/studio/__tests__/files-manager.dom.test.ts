// @vitest-environment jsdom

import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { FilesManager } from "@/components/studio/files-manager";

const labels = {
  moveTitle: "Move",
  moveHint: "hint",
  root: "(root)",
  newFolder: "New folder",
  add: "Add",
  errorConflict: "conflict",
  errorPrecondition: "precondition",
};

const draftFiles: AuthoredFlowPackageFile[] = [
  { kind: "rule", path: "rules/a.md", content: "a" },
  { kind: "asset", path: "assets/x.png", content: "" },
];

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function mount(readOnly = false, onDraftFilesChange = vi.fn()): HTMLDivElement {
  const container = document.createElement("div");

  document.body.appendChild(container);
  const root = createRoot(container);

  roots.push(root);
  act(() =>
    root.render(
      createElement(FilesManager, {
        draftFiles,
        readOnly,
        labels,
        onDraftFilesChange,
      } as never),
    ),
  );

  return container;
}

function bySource(container: HTMLElement, path: string): HTMLButtonElement {
  const el = [
    ...container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="files-manager-source"]',
    ),
  ].find((b) => b.textContent === path);

  if (!el) throw new Error(`source not found: ${path}`);

  return el;
}

function byTarget(container: HTMLElement, folder: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(
    `[data-testid="files-manager-target"][data-folder="${folder}"]`,
  );

  if (!el) throw new Error(`target not found: ${folder}`);

  return el;
}

describe("FilesManager (ADR-116 §P7, D7)", () => {
  it("moves a selected file into a folder via click", () => {
    const onDraftFilesChange = vi.fn();
    const container = mount(false, onDraftFilesChange);

    act(() => bySource(container, "rules/a.md").click());
    act(() => byTarget(container, "assets").click());

    expect(onDraftFilesChange).toHaveBeenCalledTimes(1);
    const next = onDraftFilesChange.mock.calls[0][0] as Array<{ path: string }>;

    expect(next.some((f) => f.path === "assets/a.md")).toBe(true);
    expect(next.some((f) => f.path === "rules/a.md")).toBe(false);
  });

  it("adds a virtual folder as a drop target (no sentinel persisted)", () => {
    const onDraftFilesChange = vi.fn();
    const container = mount(false, onDraftFilesChange);

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="files-manager-new-folder"]',
    );
    const desc = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value",
    );

    desc?.set?.call(input, "vendor");
    act(() => input?.dispatchEvent(new Event("input", { bubbles: true })));
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="files-manager-add-folder"]',
        )
        ?.click(),
    );

    // The virtual folder is a target but nothing was persisted (no onChange yet).
    expect(byTarget(container, "vendor")).toBeTruthy();
    expect(onDraftFilesChange).not.toHaveBeenCalled();
  });

  it("surfaces a CONFLICT error on a colliding move", () => {
    const onDraftFilesChange = vi.fn();
    const collide: AuthoredFlowPackageFile[] = [
      { kind: "rule", path: "rules/a.md", content: "a" },
      { kind: "rule", path: "dst/a.md", content: "b" },
    ];
    const container = document.createElement("div");

    document.body.appendChild(container);
    const root = createRoot(container);

    roots.push(root);
    act(() =>
      root.render(
        createElement(FilesManager, {
          draftFiles: collide,
          readOnly: false,
          labels,
          onDraftFilesChange,
        } as never),
      ),
    );

    act(() => bySource(container, "rules/a.md").click());
    act(() => byTarget(container, "dst").click());

    expect(onDraftFilesChange).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="files-manager-error"]')
        ?.textContent,
    ).toBe("conflict");
  });

  it("moves a file via drag-and-drop without a prior click-select", () => {
    // Regression: targets used to read the dragged path from a ref (no
    // re-render), so a drag with no prior click left them `disabled` and the
    // browser suppressed `onDrop` — drag-only move silently did nothing.
    const onDraftFilesChange = vi.fn();
    const container = mount(false, onDraftFilesChange);

    act(() =>
      bySource(container, "rules/a.md").dispatchEvent(
        new Event("dragstart", { bubbles: true }),
      ),
    );
    expect(byTarget(container, "assets").disabled).toBe(false);
    act(() =>
      byTarget(container, "assets").dispatchEvent(
        new Event("drop", { bubbles: true }),
      ),
    );

    expect(onDraftFilesChange).toHaveBeenCalledTimes(1);
    const next = onDraftFilesChange.mock.calls[0][0] as Array<{ path: string }>;

    expect(next.some((f) => f.path === "assets/a.md")).toBe(true);
  });

  it("moves a folder via drag (folder is both a source and a target)", () => {
    const onDraftFilesChange = vi.fn();
    const container = mount(false, onDraftFilesChange);

    act(() =>
      byTarget(container, "rules").dispatchEvent(
        new Event("dragstart", { bubbles: true }),
      ),
    );
    act(() =>
      byTarget(container, "assets").dispatchEvent(
        new Event("drop", { bubbles: true }),
      ),
    );

    expect(onDraftFilesChange).toHaveBeenCalledTimes(1);
    const next = onDraftFilesChange.mock.calls[0][0] as Array<{ path: string }>;

    expect(next.some((f) => f.path === "assets/rules/a.md")).toBe(true);
  });

  it("hides move controls when readOnly", () => {
    const container = mount(true);

    expect(
      container.querySelector('[data-testid="files-manager-sources"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="files-manager"]'),
    ).not.toBeNull();
  });
});
