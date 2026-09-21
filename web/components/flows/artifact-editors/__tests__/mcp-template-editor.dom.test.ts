// @vitest-environment jsdom

// Regression for the "Apply template" no-op (the applied MCP YAML never showed
// in the raw editor). Root cause: CodeEditor seeds its buffer ONCE and ignores
// later `value` swaps on a mounted instance — applying a template replaces the
// whole document, so the editor must be remounted to re-seed. The stub below
// mirrors that exact seed-once contract, so this test reproduces the bug
// without the remount key and passes with it.

import type { PlatformMcpCatalogEntry } from "@/lib/queries/platform-mcp-catalog";
import type { Root } from "react-dom/client";

import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Seed-once stub matching the real CodeEditor contract: `value` seeds the buffer
// at mount and is ignored thereafter unless the component is remounted (key).
vi.mock("@/components/flows/code-editor", () => ({
  CodeEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (next: string) => void;
  }) => {
    const [buffer, setBuffer] = useState(value);

    return createElement("textarea", {
      "data-testid": "raw-editor",
      value: buffer,
      onChange: (event: { target: { value: string } }) => {
        setBuffer(event.target.value);
        onChange?.(event.target.value);
      },
    });
  },
}));

import { McpTemplateEditor } from "@/components/flows/artifact-editors/mcp-template-editor";

const LABELS = {
  prefillHeading: "Prefill",
  prefillHint: "hint",
  catalogLabel: "Server",
  catalogPlaceholder: "Pick…",
  catalogEmpty: "empty",
  apply: "Apply",
  secretNotice: "secrets",
  rawHeading: "Template (YAML)",
  invalidNotice: "invalid",
};

const CATALOG: PlatformMcpCatalogEntry[] = [
  {
    id: "context7",
    description: null,
    transport: "stdio",
    command: "npx context7",
    args: [],
    url: null,
    // ADR-177 (D28): a package is shareable, so the prefill must never copy a
    // LITERAL into a template — `CONTEXT7_API_KEY` here is a literal and must
    // land as `env:CONTEXT7_API_KEY`, while an existing reference is kept.
    env: { CONTEXT7_API_KEY: "sk-literal", GH: "env:GH_TOKEN" },
    headers: {},
    bearerTokenEnv: null,
    enabled: true,
  },
  {
    id: "vendor",
    description: null,
    transport: "http",
    command: null,
    args: [],
    url: "https://mcp.example.com/v1",
    env: {},
    headers: { "X-Api-Key": "literal-key", "X-Tenant": "env:TENANT" },
    bearerTokenEnv: "env:VENDOR_TOKEN",
    enabled: true,
  },
];

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

// Controlled host mirroring the real parent (draftFiles): McpTemplateEditor's
// onChange lifts the new content, which flows back down as `content`.
function Host(): ReturnType<typeof McpTemplateEditor> {
  const [content, setContent] = useState("1");

  return createElement(McpTemplateEditor, {
    content,
    fileName: "mcps/context7.yaml",
    catalog: CATALOG,
    labels: LABELS,
    onChange: setContent,
  });
}

// Mount, select a catalog entry, Apply, and return the raw editor's text.
function applyCatalogEntry(id: string): string {
  const node = document.createElement("div");

  document.body.append(node);
  const root = createRoot(node);

  roots.push(root);
  act(() => root.render(createElement(Host)));

  const select = node.querySelector<HTMLSelectElement>(
    '[data-testid="mcp-template-catalog"]',
  );
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )!.set!;

  act(() => {
    valueSetter.call(select, id);
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => {
    node
      .querySelector<HTMLButtonElement>('[data-testid="mcp-template-apply"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  return node.querySelector<HTMLTextAreaElement>('[data-testid="raw-editor"]')!
    .value;
}

describe("McpTemplateEditor apply", () => {
  it("re-seeds the raw editor with the materialized YAML on Apply", () => {
    const node = document.createElement("div");

    document.body.append(node);
    const root = createRoot(node);

    roots.push(root);
    act(() => root.render(createElement(Host)));

    const select = node.querySelector<HTMLSelectElement>(
      '[data-testid="mcp-template-catalog"]',
    );
    const raw = (): HTMLTextAreaElement =>
      node.querySelector<HTMLTextAreaElement>('[data-testid="raw-editor"]')!;

    expect(raw().value).toBe("1");

    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )!.set!;

    act(() => {
      valueSetter.call(select, "context7");
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const apply = node.querySelector<HTMLButtonElement>(
      '[data-testid="mcp-template-apply"]',
    );

    act(() => {
      apply!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(raw().value).not.toBe("1");
    expect(raw().value).toContain("transport: stdio");
    expect(raw().value).toContain("id: context7");
  });

  // ADR-177 (D28): the prefill NEVER writes a literal into a shareable package.
  it("converts a platform literal into env:<KEY> and copies a reference as-is", () => {
    const raw = applyCatalogEntry("context7");

    expect(raw).toContain("CONTEXT7_API_KEY: env:CONTEXT7_API_KEY");
    expect(raw).toContain("GH: env:GH_TOKEN");
    // The literal itself must not appear anywhere in the template.
    expect(raw).not.toContain("sk-literal");
  });

  it("sanitizes a header name into a valid env name and carries the bearer ref", () => {
    const raw = applyCatalogEntry("vendor");

    // `X-Api-Key` is not an env name; uppercased with `-` -> `_`.
    expect(raw).toContain("X_API_KEY: env:X_API_KEY");
    expect(raw).toContain("X_TENANT: env:TENANT");
    expect(raw).toContain("env:VENDOR_TOKEN");
    expect(raw).not.toContain("literal-key");
  });
});
