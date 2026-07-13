// @vitest-environment jsdom

import type { FlowMetadata } from "@/lib/config.schema";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FlowMetadataForm,
  type FlowMetadataFormLabels,
} from "@/components/flows/node-form/flow-metadata-form";

const LABELS: FlowMetadataFormLabels = {
  heading: "Flow properties",
  hint: "Header metadata for this flow.",
  title: "Title",
  summary: "Summary",
  routeWhen: "Route when",
  routeWhenHint: "Natural-language routing hint.",
  labels: "Labels",
  labelsList: { add: "Add label", remove: "Remove", placeholder: "label" },
  links: {
    field: "Links",
    add: "Add link",
    remove: "Remove",
    title: "Title",
    url: "URL",
    kind: "Kind",
  },
  sources: {
    field: "Sources",
    add: "Add source",
    remove: "Remove",
    component: "Component",
    origin: "Origin",
  },
};

const roots: Root[] = [];

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(props: {
  metadata: FlowMetadata | undefined;
  readOnly?: boolean;
  onChange: (next: FlowMetadata) => void;
}): HTMLDivElement {
  const container = document.createElement("div");

  document.body.appendChild(container);
  const root = createRoot(container);

  roots.push(root);
  act(() => {
    root.render(createElement(FlowMetadataForm, { labels: LABELS, ...props }));
  });

  return container;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function typeInto(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

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

describe("FlowMetadataForm", () => {
  it("renders existing metadata values", () => {
    const container = render({
      metadata: {
        summary: "A flow",
        labels: ["bug"],
        links: [{ title: "RB", url: "https://x.dev" }],
      },
      onChange: vi.fn(),
    });

    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid="flow-meta-summary"]',
      )!.value,
    ).toBe("A flow");
    expect(
      container.querySelector('[data-testid="flow-meta-labels"]'),
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid="flow-meta-link-0-url"]',
      )!.value,
    ).toBe("https://x.dev");
  });

  it("emits a merged patch when the summary is edited", () => {
    const onChange = vi.fn();
    const container = render({ metadata: { title: "Keep" }, onChange });

    typeInto(
      container.querySelector<HTMLTextAreaElement>(
        '[data-testid="flow-meta-summary"]',
      )!,
      "new summary",
    );

    expect(onChange).toHaveBeenCalledWith({
      title: "Keep",
      summary: "new summary",
    });
  });

  it("appends a blank link row on add-link", () => {
    const onChange = vi.fn();
    const container = render({
      metadata: { links: [{ title: "a", url: "b" }] },
      onChange,
    });

    click(container.querySelector('[data-testid="flow-meta-links-add"]')!);

    expect(onChange).toHaveBeenCalledWith({
      links: [
        { title: "a", url: "b" },
        { title: "", url: "" },
      ],
    });
  });

  it("drops add/remove affordances in readOnly", () => {
    const container = render({
      metadata: { links: [{ title: "a", url: "b" }] },
      readOnly: true,
      onChange: vi.fn(),
    });

    expect(
      container.querySelector('[data-testid="flow-meta-links-add"]'),
    ).toBeNull();
  });
});
