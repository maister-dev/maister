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

describe("PackageComposition inline Save (ADR-115 §P3)", () => {
  it("the inline Save button persists the draft via onSaveDraft", () => {
    nav.search = "tab=rules&sel=r1.md";
    const onSaveDraft = vi.fn();
    const container = document.createElement("div");

    document.body.appendChild(container);
    mount(
      container,
      createElement(PackageComposition, {
        packageId: "pkg1",
        name: "my-pkg",
        bom,
        fileCount: 1,
        readOnly: false,
        draftFiles: [{ kind: "rule", path: "rules/r1.md", content: "x" }],
        filesLabels,
        mcpCatalog: [],
        saveLabel: "Save",
        filesEditor: createElement("div"),
        onDraftFilesChange: vi.fn(),
        onSaveDraft,
      } as never),
    );

    const saveBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="composition-inline-save"]',
    );

    expect(saveBtn).not.toBeNull();
    act(() => saveBtn?.click());

    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });
});
