// @vitest-environment jsdom

import type { ReactElement } from "react";

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SchemaRefField } from "@/components/flows/node-form/schema-ref-field";

const LABELS = {
  placeholder: "Pick or type a schema ref",
  emptyHint: "No schemas yet",
  create: "Create schema",
  edit: "Edit schema",
  paste: "Paste JSON",
  title: "Schema title",
  json: "Schema JSON",
};
const REVIEW_SCHEMA = JSON.stringify({
  schemaVersion: 1,
  fields: [{ name: "review", type: "string" }],
});
const INTAKE_SCHEMA = JSON.stringify({
  schemaVersion: 1,
  fields: [{ name: "intake", type: "string" }],
});

const roots: Root[] = [];

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

function field(
  props: Partial<Parameters<typeof SchemaRefField>[0]> = {},
): ReactElement {
  return createElement(SchemaRefField, {
    value: "./schemas/review.json",
    label: "Form schema",
    testid: "node-form-schema",
    labels: LABELS,
    readOnly: false,
    schemaFiles: [
      { path: "schemas/review.json", content: '{"fields":[]}' },
      { path: "schemas/intake.json", content: '{"fields":[]}' },
    ],
    onChange: () => undefined,
    onWriteSchemaFile: () => undefined,
    ...props,
  });
}

function setupActEnvironment(): void {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
}

function renderClient(element: ReactElement): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);

  act(() => {
    root.render(element);
  });

  return { container, root };
}

function findTextarea(container: ParentNode): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");

  if (!textarea) throw new Error("textarea not found");

  return textarea;
}

function findButton(container: ParentNode, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === label,
  );

  if (!button) throw new Error(`button not found: ${label}`);

  return button;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("SchemaRefField", () => {
  beforeEach(() => {
    setupActEnvironment();
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    roots.length = 0;
    document.body.innerHTML = "";
  });

  it("renders existing schema options and keeps the caller's input testid", () => {
    const html = render(field());

    expect(html).toContain('data-testid="node-form-schema"');
    expect(html).toContain("Form schema");
    expect(html).toContain("review");
    expect(html).toContain("intake");
    expect(html).toContain("./schemas/review.json");
  });

  it("shows create/edit affordances only when schema files and writer are present", () => {
    const writable = render(field());
    const readThrough = render(
      field({ schemaFiles: undefined, onWriteSchemaFile: undefined }),
    );

    expect(writable).toContain("Create schema");
    expect(writable).toContain("Edit schema");
    expect(writable).toContain("Paste JSON");
    expect(readThrough).not.toContain("Create schema");
    expect(readThrough).not.toContain("Edit schema");
    expect(readThrough).not.toContain("Paste JSON");
  });

  it("disables the input and hides create/edit actions in read-only mode", () => {
    const html = render(field({ readOnly: true }));

    expect(html).toMatch(/disabled=""/);
    expect(html).not.toContain("Create schema");
    expect(html).not.toContain("Edit schema");
    expect(html).not.toContain("Paste JSON");
  });

  it("renders an inline validation error as an alert", () => {
    const html = render(field({ error: "Schema JSON is invalid." }));

    expect(html).toContain('role="alert"');
    expect(html).toContain("Schema JSON is invalid.");
  });

  it("loads the current schema content before editing a changed selection", async () => {
    const write = vi.fn();
    const schemaFiles = [
      { path: "schemas/intake.json", content: INTAKE_SCHEMA },
      { path: "schemas/review.json", content: REVIEW_SCHEMA },
    ];
    const { container, root } = renderClient(
      field({
        value: "./schemas/intake.json",
        schemaFiles,
        onWriteSchemaFile: write,
      }),
    );

    expect(findTextarea(container).value).toBe(INTAKE_SCHEMA);

    await act(async () => {
      root.render(
        field({
          value: "./schemas/review.json",
          schemaFiles,
          onWriteSchemaFile: write,
        }),
      );
    });

    expect(findTextarea(container).value).toBe(REVIEW_SCHEMA);

    await click(findButton(container, "Edit schema"));

    expect(write).toHaveBeenCalledWith(
      "schemas/review.json",
      expect.stringContaining('"name": "review"'),
    );
  });
});
