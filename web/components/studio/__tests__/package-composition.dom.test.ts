// @vitest-environment jsdom

import type { PackageBom } from "@/lib/queries/package-bom";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { packageFilesEditorLabels } from "@/lib/flows/editor/editor-labels";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ search: "" }));

vi.mock("next-intl", () => ({
  useTranslations: () =>
    Object.assign((key: string) => key, { raw: (key: string) => key }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));

import { PackageComposition } from "@/components/studio/package-composition";

const stubT = Object.assign((key: string) => key, {
  raw: (key: string) => key,
});
const filesLabels = packageFilesEditorLabels(
  stubT as never,
  stubT as never,
  true,
);

const bom: PackageBom = {
  flows: [],
  skills: [],
  subagents: [],
  platformAgents: [],
  mcps: [],
  rules: [{ id: "r1.md", path: "rules/r1.md" }],
};

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function mount(
  node: HTMLElement,
  element: Parameters<Root["render"]>[0],
): void {
  const root = createRoot(node);

  roots.push(root);
  act(() => root.render(element));
}

function baseProps(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    packageId: "pkg1",
    name: "my-pkg",
    bom,
    fileCount: 1,
    readOnly: false,
    dirty: true,
    draftFiles: [{ kind: "rule", path: "rules/r1.md", content: "x" }],
    filesLabels,
    mcpCatalog: [],
    saveLabel: "Save",
    filesEditor: createElement("div"),
    onDraftFilesChange: vi.fn(),
    onSaveDraft: vi.fn(),
    onCreateArtifact: vi.fn(),
    ...overrides,
  };
}

function setNativeValue(el: HTMLInputElement, value: string): void {
  const desc = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    "value",
  );

  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectValue(el: HTMLSelectElement, value: string): void {
  const desc = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    "value",
  );

  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("PackageComposition inline Save (ADR-116 §P3)", () => {
  it("the inline Save button persists the draft via onSaveDraft", () => {
    nav.search = "tab=rules&sel=r1.md";
    const onSaveDraft = vi.fn();
    const container = document.createElement("div");

    document.body.appendChild(container);
    mount(
      container,
      createElement(PackageComposition, baseProps({ onSaveDraft }) as never),
    );

    const saveBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="composition-inline-save"]',
    );

    expect(saveBtn).not.toBeNull();
    act(() => saveBtn?.click());

    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });

  it("shows a top + bottom Save, both disabled when the draft is clean", () => {
    nav.search = "tab=rules&sel=r1.md";
    const container = document.createElement("div");

    document.body.appendChild(container);
    mount(
      container,
      createElement(PackageComposition, baseProps({ dirty: false }) as never),
    );

    const top = container.querySelector<HTMLButtonElement>(
      '[data-testid="composition-inline-save-top"]',
    );
    const bottom = container.querySelector<HTMLButtonElement>(
      '[data-testid="composition-inline-save"]',
    );

    expect(top).not.toBeNull();
    expect(bottom).not.toBeNull();
    expect(top?.disabled).toBe(true);
    expect(bottom?.disabled).toBe(true);
  });
});

describe("PackageComposition create (ADR-116 §P5)", () => {
  it("scaffolds a rule and persists it via onCreateArtifact", () => {
    nav.search = "tab=files";
    const onCreateArtifact = vi.fn();
    const container = document.createElement("div");

    document.body.appendChild(container);
    mount(
      container,
      createElement(
        PackageComposition,
        baseProps({ onCreateArtifact }) as never,
      ),
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="composition-create-open"]',
        )
        ?.click(),
    );

    act(() =>
      selectValue(
        container.querySelector('[data-testid="composition-create-kind"]')!,
        "rule",
      ),
    );

    const nameInput = container.querySelector<HTMLInputElement>(
      '[data-testid="composition-create-name"]',
    );

    expect(nameInput).not.toBeNull();
    act(() => setNativeValue(nameInput as HTMLInputElement, "style"));
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="composition-create-submit"]',
        )
        ?.click(),
    );

    expect(onCreateArtifact).toHaveBeenCalledTimes(1);
    const [files, navigate] = onCreateArtifact.mock.calls[0] as [
      Array<{ path: string }>,
      string,
    ];

    expect(files.some((f) => f.path === "rules/style.md")).toBe(true);
    expect(navigate).toBe("/studio/edit/pkg1?tab=rules&sel=style");
  });

  it("renames a selected inline element via onCreateArtifact", () => {
    nav.search = "tab=rules&sel=r1.md";
    const onCreateArtifact = vi.fn();
    const container = document.createElement("div");

    document.body.appendChild(container);
    mount(
      container,
      createElement(
        PackageComposition,
        baseProps({ onCreateArtifact }) as never,
      ),
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="composition-inline-rename-open"]',
        )
        ?.click(),
    );
    act(() =>
      setNativeValue(
        container.querySelector(
          '[data-testid="composition-inline-rename-name"]',
        )!,
        "renamed",
      ),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="composition-inline-rename-submit"]',
        )
        ?.click(),
    );

    expect(onCreateArtifact).toHaveBeenCalledTimes(1);
    const [files, navigate] = onCreateArtifact.mock.calls[0] as [
      Array<{ path: string }>,
      string,
    ];

    expect(files.some((f) => f.path === "rules/renamed.md")).toBe(true);
    expect(navigate).toBe("/studio/edit/pkg1?tab=rules&sel=renamed.md");
  });

  it("requires a capability before scaffolding a subagent", () => {
    nav.search = "tab=files";
    const onCreateArtifact = vi.fn();
    const container = document.createElement("div");

    document.body.appendChild(container);
    mount(
      container,
      createElement(
        PackageComposition,
        baseProps({ onCreateArtifact }) as never,
      ),
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="composition-create-open"]',
        )
        ?.click(),
    );
    act(() =>
      selectValue(
        container.querySelector('[data-testid="composition-create-kind"]')!,
        "subagent",
      ),
    );
    act(() =>
      setNativeValue(
        container.querySelector('[data-testid="composition-create-name"]')!,
        "helper",
      ),
    );
    // Capability left blank.
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="composition-create-submit"]',
        )
        ?.click(),
    );

    expect(onCreateArtifact).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="composition-create-error"]')
        ?.textContent,
    ).toBe("composition.create.errorCapabilityRequired");
  });

  it("keeps the rename form open and errors on a colliding rename", () => {
    nav.search = "tab=rules&sel=r1.md";
    const onCreateArtifact = vi.fn();
    const container = document.createElement("div");

    document.body.appendChild(container);
    mount(
      container,
      createElement(
        PackageComposition,
        baseProps({
          onCreateArtifact,
          bom: {
            ...bom,
            rules: [
              { id: "r1.md", path: "rules/r1.md" },
              { id: "r2.md", path: "rules/r2.md" },
            ],
          },
          draftFiles: [
            { kind: "rule", path: "rules/r1.md", content: "x" },
            { kind: "rule", path: "rules/r2.md", content: "y" },
          ],
        }) as never,
      ),
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="composition-inline-rename-open"]',
        )
        ?.click(),
    );
    act(() =>
      setNativeValue(
        container.querySelector(
          '[data-testid="composition-inline-rename-name"]',
        )!,
        "r2",
      ),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="composition-inline-rename-submit"]',
        )
        ?.click(),
    );

    expect(onCreateArtifact).not.toHaveBeenCalled();
    // Form stays open (submit still present) with an error for correction.
    expect(
      container.querySelector(
        '[data-testid="composition-inline-rename-submit"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="composition-inline-rename-error"]',
      ),
    ).not.toBeNull();
  });

  it("shows a CONFLICT error and does not create on a colliding name", () => {
    nav.search = "tab=files";
    const onCreateArtifact = vi.fn();
    const container = document.createElement("div");

    document.body.appendChild(container);
    mount(
      container,
      createElement(
        PackageComposition,
        baseProps({ onCreateArtifact }) as never,
      ),
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="composition-create-open"]',
        )
        ?.click(),
    );
    // Default kind is "flow"; type the existing rule name as a rule instead.
    const kindSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="composition-create-kind"]',
    );

    if (kindSelect) {
      const desc = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(kindSelect),
        "value",
      );

      desc?.set?.call(kindSelect, "rule");
      kindSelect.dispatchEvent(new Event("change", { bubbles: true }));
    }
    act(() =>
      setNativeValue(
        container.querySelector('[data-testid="composition-create-name"]')!,
        "r1",
      ),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="composition-create-submit"]',
        )
        ?.click(),
    );

    expect(onCreateArtifact).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="composition-create-error"]'),
    ).not.toBeNull();
  });
});

describe("PackageComposition live filter", () => {
  it("filters the subagents list by name substring", () => {
    nav.search = "tab=subagents";
    const container = document.createElement("div");

    document.body.appendChild(container);
    mount(
      container,
      createElement(
        PackageComposition,
        baseProps({
          bom: {
            ...bom,
            subagents: [
              { id: "helper", path: "a/helper.md", description: "" },
              { id: "worker", path: "a/worker.md", description: "" },
            ],
          },
        }) as never,
      ),
    );

    expect(
      container.querySelectorAll('[data-testid="element-card"]').length,
    ).toBe(2);

    act(() =>
      setNativeValue(
        container.querySelector('[data-testid="composition-filter"]')!,
        "help",
      ),
    );

    const cards = [
      ...container.querySelectorAll('[data-testid="element-card"]'),
    ];

    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain("helper");
  });
});
