// @vitest-environment jsdom

import type {
  McpSelectLabels,
  McpSelectOption,
} from "@/components/mcp/mcp-select";
import type { ReactElement } from "react";

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { McpSelect } from "@/components/mcp/mcp-select";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

const labels: McpSelectLabels = {
  empty: "none",
  placeholder: "type",
  add: "Add",
};

function mount(node: ReactElement): void {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);
  act(() => root.render(node));
}

async function type(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;

    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("McpSelect type-to-filter (ADR-129 T7.1 — behavioral)", () => {
  it("narrows unselected options by the free-add query, keeping selected ones", async () => {
    const options: McpSelectOption[] = [
      { value: "github", label: "GitHub" },
      { value: "postgres", label: "Postgres" },
      { value: "filesystem", label: "Filesystem" },
    ];

    mount(
      createElement(McpSelect, {
        testid: "sel",
        values: ["github"],
        options,
        labels,
        allowFreeAdd: true,
        onChange: vi.fn(),
      }),
    );

    const input = document.body.querySelector<HTMLInputElement>(
      '[data-testid="sel-input"]',
    );

    if (!input) throw new Error("input not found");
    await type(input, "post");

    const has = (v: string): boolean =>
      !!document.body.querySelector(`[data-testid="sel-option-${v}"]`);

    expect(has("github")).toBe(true); // selected → always visible
    expect(has("postgres")).toBe(true); // matches "post"
    expect(has("filesystem")).toBe(false); // unselected, no match → filtered out
  });
});
