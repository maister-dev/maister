// @vitest-environment jsdom

import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ replace: vi.fn() }));
const nav = vi.hoisted(() => ({ search: "tab=files" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: router.replace,
    push: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/studio/edit/p1",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

// Stub the heavy per-kind content editor — the navigator owns the left pane.
vi.mock("@/components/flows/package-files-editor", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/components/flows/package-files-editor")
    >();

  return {
    ...actual,
    ContentEditor: ({ file }: { file: AuthoredFlowPackageFile }) =>
      createElement("div", { "data-testid": "content-editor" }, file.path),
  };
});

import { PackageFileNavigator } from "@/components/studio/package-file-navigator";

const labels = {
  viewFinder: "Finder",
  viewTree: "Tree",
  newFile: "File",
  newFolder: "Folder",
  newFolderName: "Folder name",
  root: "Package",
  save: "Save",
  empty: "empty",
  selectHint: "select a file",
  rename: "Rename",
  remove: "Delete",
  confirm: "Add",
  cancel: "Cancel",
  errorConflict: "conflict",
  errorPrecondition: "invalid",
};

const draftFiles: AuthoredFlowPackageFile[] = [
  { kind: "manifest", path: "maister-package.yaml", content: "m" },
  { kind: "rule", path: "rules/r1.md", content: "1" },
  { kind: "rule", path: "rules/sub/r2.md", content: "2" },
];

const roots: Root[] = [];

afterEach(() => {
  router.replace.mockClear();
  nav.search = "tab=files";
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function mount(
  onDraftFilesChange = vi.fn(),
  files = draftFiles,
): HTMLDivElement {
  const container = document.createElement("div");

  document.body.appendChild(container);
  const root = createRoot(container);

  roots.push(root);
  act(() =>
    root.render(
      createElement(PackageFileNavigator, {
        draftFiles: files,
        readOnly: false,
        labels,
        filesLabels: {} as never,
        mcpCatalog: [],
        onDraftFilesChange,
        onSaveDraft: vi.fn(),
      } as never),
    ),
  );

  return container;
}

function fileRow(c: HTMLElement, path: string): HTMLElement {
  const el = [
    ...c.querySelectorAll<HTMLElement>('[data-testid="file-nav-file"]'),
  ].find((r) => r.dataset.path === path);

  if (!el) throw new Error(`file row not found: ${path}`);

  return el;
}

function folderRow(c: HTMLElement, folder: string): HTMLElement {
  const el = [
    ...c.querySelectorAll<HTMLElement>('[data-testid="file-nav-folder"]'),
  ].find((r) => r.dataset.folder === folder);

  if (!el) throw new Error(`folder row not found: ${folder}`);

  return el;
}

describe("PackageFileNavigator (ADR-116 file navigator)", () => {
  it("tree mode renders root files + folders and opens a file on click", () => {
    const c = mount();

    expect(folderRow(c, "rules")).toBeTruthy();
    expect(fileRow(c, "maister-package.yaml")).toBeTruthy();
    // The nested file is hidden until the folder is expanded.
    expect(
      [
        ...c.querySelectorAll<HTMLElement>('[data-testid="file-nav-file"]'),
      ].some((r) => r.dataset.path === "rules/r1.md"),
    ).toBe(false);

    act(() =>
      fileRow(c, "maister-package.yaml").querySelector("button")?.click(),
    );
    expect(c.querySelector('[data-testid="content-editor"]')?.textContent).toBe(
      "maister-package.yaml",
    );
  });

  it("expands a folder in tree mode to reveal nested files", () => {
    const c = mount();

    act(() =>
      folderRow(c, "rules")
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-nav-folder-toggle"]',
        )
        ?.click(),
    );

    expect(fileRow(c, "rules/r1.md")).toBeTruthy();
    expect(folderRow(c, "rules/sub")).toBeTruthy();
  });

  it("creates a new file in the current folder", () => {
    const onChange = vi.fn();
    const c = mount(onChange);

    act(() =>
      c
        .querySelector<HTMLButtonElement>('[data-testid="file-nav-new-file"]')
        ?.click(),
    );

    const next = onChange.mock.calls[0][0] as AuthoredFlowPackageFile[];

    expect(next.some((f) => f.path === "new-file.md")).toBe(true);
  });

  it("renames a file via the inline editor", () => {
    const onChange = vi.fn();
    const c = mount(onChange);

    act(() =>
      folderRow(c, "rules")
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-nav-folder-toggle"]',
        )
        ?.click(),
    );
    act(() =>
      fileRow(c, "rules/r1.md")
        .querySelector<HTMLButtonElement>('[data-testid="file-nav-rename"]')
        ?.click(),
    );

    const input = c.querySelector<HTMLInputElement>(
      '[data-testid="file-nav-rename-input"]',
    )!;
    const desc = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value",
    );

    desc?.set?.call(input, "renamed.md");
    act(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );

    const next = onChange.mock.calls.at(-1)?.[0] as AuthoredFlowPackageFile[];

    expect(next.some((f) => f.path === "rules/renamed.md")).toBe(true);
    expect(next.some((f) => f.path === "rules/r1.md")).toBe(false);
  });

  it("deletes a file", () => {
    const onChange = vi.fn();
    const c = mount(onChange);

    act(() =>
      fileRow(c, "maister-package.yaml")
        .querySelector<HTMLButtonElement>('[data-testid="file-nav-remove"]')
        ?.click(),
    );

    const next = onChange.mock.calls[0][0] as AuthoredFlowPackageFile[];

    expect(next.some((f) => f.path === "maister-package.yaml")).toBe(false);
  });

  it("moves a file into a folder by drag-and-drop", () => {
    const onChange = vi.fn();
    const c = mount(onChange);

    act(() =>
      fileRow(c, "maister-package.yaml").dispatchEvent(
        new Event("dragstart", { bubbles: true }),
      ),
    );
    act(() =>
      folderRow(c, "rules").dispatchEvent(new Event("drop", { bubbles: true })),
    );

    const next = onChange.mock.calls.at(-1)?.[0] as AuthoredFlowPackageFile[];

    expect(next.some((f) => f.path === "rules/maister-package.yaml")).toBe(
      true,
    );
  });

  it("switches view mode via the URL", () => {
    const c = mount();

    act(() =>
      c
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-nav-view-finder"]',
        )
        ?.click(),
    );

    expect(router.replace).toHaveBeenCalledWith(
      expect.stringContaining("fileview=finder"),
      { scroll: false },
    );
  });

  it("creates a virtual folder that appears in the tree", () => {
    const c = mount();

    act(() =>
      c
        .querySelector<HTMLButtonElement>('[data-testid="file-nav-new-folder"]')
        ?.click(),
    );
    const input = c.querySelector<HTMLInputElement>(
      '[data-testid="file-nav-new-folder-input"]',
    )!;
    const desc = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value",
    );

    desc?.set?.call(input, "vendor");
    act(() => input.dispatchEvent(new Event("input", { bubbles: true })));
    act(() =>
      c
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-nav-new-folder-confirm"]',
        )
        ?.click(),
    );

    expect(folderRow(c, "vendor")).toBeTruthy();
  });
});
