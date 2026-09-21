// @vitest-environment jsdom

// ADR-177: the platform MCP modal's behaviour under the value model. The SSR
// suite beside this one covers which FIELDS render; these cases cover what the
// form DOES — what reaches the request body, and what blocks submit.
//
// The central case is D9/D24: a literal under a secret-shaped key WARNS and is
// still SUBMITTED. A warning that blocked would be a refusal in disguise, and
// the routes are asserted to accept the value.

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpServerModal } from "@/components/settings/mcp-server-modal";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The modal reads labels through `useTranslations("settings")`; echo the key so
// an assertion names the contract rather than a translation.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const roots: Root[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
});

function mount(): HTMLElement {
  const node = document.createElement("div");

  document.body.append(node);
  const root = createRoot(node);

  roots.push(root);
  act(() =>
    root.render(
      createElement(McpServerModal, {
        mode: "create",
        onClose() {},
        onSaved() {},
      }),
    ),
  );

  return node;
}

function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;

  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function selectTransport(node: HTMLElement, transport: string): void {
  const select = node.querySelector("select")!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )!.set!;

  act(() => {
    setter.call(select, transport);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function byLabel(node: HTMLElement, label: string): HTMLInputElement[] {
  return [
    ...node.querySelectorAll<HTMLInputElement>(`[aria-label="${label}"]`),
  ];
}

function addRow(node: HTMLElement, addLabel: string): void {
  act(() => {
    [...node.querySelectorAll("button")]
      .find((b) => b.textContent?.includes(addLabel))!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

// The id field is the first text input; the modal needs it to validate.
function fillIdAndCommand(node: HTMLElement, id = "github"): void {
  const text = [
    ...node.querySelectorAll<HTMLInputElement>('input[type="text"]'),
  ];

  setValue(text[0]!, id);
  // description, then command (stdio default)
  setValue(text[2]!, "npx");
}

function submitButton(node: HTMLElement): HTMLButtonElement {
  return [...node.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("save"),
  )!;
}

function submittedBody(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);

  return JSON.parse(
    (fetchMock.mock.calls[0]![1] as { body: string }).body,
  ) as Record<string, unknown>;
}

describe("McpServerModal — value model (ADR-177)", () => {
  it("WARNS on a literal under a secret-shaped key and still submits it (D9/D24)", () => {
    const node = mount();

    fillIdAndCommand(node);
    addRow(node, "addEnv");
    setValue(byLabel(node, "fieldEnvKey")[0]!, "GITHUB_TOKEN");
    setValue(byLabel(node, "fieldEnvValue")[0]!, "ghp_x");

    // Inline, non-blocking, and NOT an invalid marker.
    expect(node.querySelector('[role="note"]')?.textContent).toBe(
      "secretShapedWarning",
    );
    expect(
      byLabel(node, "fieldEnvKey")[0]!.getAttribute("aria-invalid"),
    ).toBeNull();

    act(() => {
      submitButton(node).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    // The route accepts the value; the guard is advisory.
    expect(submittedBody().env).toEqual({ GITHUB_TOKEN: "ghp_x" });
  });

  it("does NOT warn when the same key holds a reference", () => {
    const node = mount();

    fillIdAndCommand(node);
    addRow(node, "addEnv");
    setValue(byLabel(node, "fieldEnvKey")[0]!, "GITHUB_TOKEN");
    setValue(byLabel(node, "fieldEnvValue")[0]!, "env:GITHUB_TOKEN");

    expect(node.querySelector('[role="note"]')).toBeNull();
  });

  it("shows a row error and BLOCKS submit for a malformed env: value", () => {
    const node = mount();

    fillIdAndCommand(node);
    addRow(node, "addEnv");
    setValue(byLabel(node, "fieldEnvKey")[0]!, "GH");
    setValue(byLabel(node, "fieldEnvValue")[0]!, "env:bad name");

    expect(byLabel(node, "fieldEnvKey")[0]!.getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(submitButton(node).disabled).toBe(true);
  });

  it("BLOCKS submit on a duplicate key and flags BOTH rows", () => {
    const node = mount();

    fillIdAndCommand(node);
    addRow(node, "addEnv");
    addRow(node, "addEnv");
    setValue(byLabel(node, "fieldEnvKey")[0]!, "A");
    setValue(byLabel(node, "fieldEnvKey")[1]!, "A");

    // Without this the map collapses silently and one value is lost.
    for (const input of byLabel(node, "fieldEnvKey")) {
      expect(input.getAttribute("aria-invalid")).toBe("true");
    }
    expect(submitButton(node).disabled).toBe(true);
  });

  it("blocks submit when bearerTokenEnv meets an Authorization header row", () => {
    const node = mount();
    const text = () => [
      ...node.querySelectorAll<HTMLInputElement>('input[type="text"]'),
    ];

    setValue(text()[0]!, "remote");
    selectTransport(node, "http");
    // url, then bearer token env
    setValue(text()[2]!, "https://mcp.example.com/v1");
    setValue(text()[3]!, "env:MCP_TOKEN");
    addRow(node, "addHeader");
    setValue(byLabel(node, "fieldHeaderName")[0]!, "Authorization");
    setValue(byLabel(node, "fieldHeaderValue")[0]!, "Basic abc");

    expect(submitButton(node).disabled).toBe(true);
    expect(node.textContent).toContain("bearerTokenEnv");
  });

  it("switching to stdio hides the header rows and the bearer field", () => {
    const node = mount();

    selectTransport(node, "http");
    expect(node.textContent).toContain("fieldBearerTokenEnv");
    expect(node.textContent).toContain("fieldHeaders");

    selectTransport(node, "stdio");
    expect(node.textContent).not.toContain("fieldBearerTokenEnv");
    expect(node.textContent).not.toContain("fieldHeaders");
    expect(node.textContent).toContain("fieldEnv");
  });

  it("notes that codex will withhold an sse server, without blocking", () => {
    const node = mount();

    selectTransport(node, "sse");

    // The launch precondition is carried into the CREATE surface: the operator
    // learns it here rather than at the launch that fails.
    expect(node.textContent).toContain("sseCodexNotice");
    expect(node.textContent).toContain("transportSseLegacy");
  });
});
