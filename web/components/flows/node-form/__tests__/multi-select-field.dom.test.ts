// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MultiSelectField,
  type MultiSelectOption,
} from "@/components/flows/node-form/multi-select-field";

const LABELS = {
  add: "Add",
  remove: "Remove",
  placeholder: "Pick or type",
  empty: "None selected",
};
const OPTIONS: MultiSelectOption[] = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta" },
];

const roots: Root[] = [];

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(props: {
  values: string[];
  mode: "catalog" | "fixed";
  readOnly?: boolean;
  onChange: (next: string[]) => void;
}): HTMLDivElement {
  const container = document.createElement("div");

  document.body.appendChild(container);
  const root = createRoot(container);

  roots.push(root);
  act(() => {
    root.render(
      createElement(MultiSelectField, {
        testid: "field",
        label: "Field",
        options: OPTIONS,
        labels: LABELS,
        ...props,
      }),
    );
  });

  return container;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;

  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("MultiSelectField", () => {
  it("adds a value when a suggestion option is clicked", () => {
    const onChange = vi.fn();
    const container = render({ values: [], mode: "catalog", onChange });

    click(container.querySelector('[data-testid="field-option"]')!);

    expect(onChange).toHaveBeenCalledWith(["alpha"]);
  });

  it("removes a value when its chip × is clicked", () => {
    const onChange = vi.fn();
    const container = render({ values: ["alpha"], mode: "catalog", onChange });

    click(container.querySelector('[data-testid="field-chip"] button')!);

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("free-adds a typed value not in the catalog", () => {
    const onChange = vi.fn();
    const container = render({ values: [], mode: "catalog", onChange });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="field-input"]',
    )!;

    typeInto(input, "custom-skill");
    const freeAdd = container.querySelector('[data-testid="field-free-add"]');

    expect(freeAdd).not.toBeNull();
    click(freeAdd!);
    expect(onChange).toHaveBeenCalledWith(["custom-skill"]);
  });

  it("rejects free-add in fixed mode", () => {
    const onChange = vi.fn();
    const container = render({ values: [], mode: "fixed", onChange });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="field-input"]',
    )!;

    typeInto(input, "not-an-option");

    expect(
      container.querySelector('[data-testid="field-free-add"]'),
    ).toBeNull();
  });

  it("renders chips only and the empty hint when read-only", () => {
    const onChange = vi.fn();
    const container = render({
      values: [],
      mode: "catalog",
      readOnly: true,
      onChange,
    });

    expect(container.querySelector('[data-testid="field-input"]')).toBeNull();
    expect(container.textContent).toContain("None selected");
  });
});
