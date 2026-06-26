// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StringListField } from "@/components/flows/node-form/string-list-field";

const LABELS = { add: "Add", remove: "Remove", placeholder: "Value" };

const roots: Root[] = [];

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(props: {
  values: string[];
  readOnly?: boolean;
  onChange: (next: string[]) => void;
}): HTMLDivElement {
  const container = document.createElement("div");

  document.body.appendChild(container);
  const root = createRoot(container);

  roots.push(root);
  act(() => {
    root.render(
      createElement(StringListField, {
        testid: "list",
        label: "List",
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

describe("StringListField", () => {
  it("appends an empty row via the add-first affordance", () => {
    const onChange = vi.fn();
    const container = render({ values: [], onChange });

    expect(container.querySelectorAll("input")).toHaveLength(0);
    click(container.querySelector('[data-testid="list-add"]')!);

    expect(onChange).toHaveBeenCalledWith([""]);
  });

  it("edits a row value", () => {
    const onChange = vi.fn();
    const container = render({ values: ["a", "b"], onChange });

    typeInto(
      container.querySelector<HTMLInputElement>('[data-testid="list-1"]')!,
      "bee",
    );

    expect(onChange).toHaveBeenCalledWith(["a", "bee"]);
  });

  it("removes a row", () => {
    const onChange = vi.fn();
    const container = render({ values: ["a", "b"], onChange });

    click(container.querySelector('[data-testid="list-remove-0"]')!);

    expect(onChange).toHaveBeenCalledWith(["b"]);
  });

  it("is read-only safe (no add/remove controls; inputs read-only)", () => {
    const onChange = vi.fn();
    const container = render({ values: ["a"], readOnly: true, onChange });

    expect(container.querySelector('[data-testid="list-add"]')).toBeNull();
    expect(container.querySelector('[data-testid="list-remove-0"]')).toBeNull();
    expect(
      container.querySelector<HTMLInputElement>('[data-testid="list-0"]')
        ?.readOnly,
    ).toBe(true);
  });
});
