// @vitest-environment jsdom

import type { McpBindingView } from "@/components/board/panels/mcp-panel";
import type { ReactElement } from "react";

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations:
    () =>
    (key: string, vars?: Record<string, unknown>): string =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

import {
  MatchDialog,
  OverlayDialog,
} from "@/components/board/panels/mcp-bind-dialogs";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type FetchCall = { url: string; method: string; body: unknown };

const roots: Root[] = [];
let calls: FetchCall[] = [];

function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      // sendJson reads only `res.ok` on the success path.
      return Promise.resolve({ ok: true, status: 200 } as Response);
    }),
  );
}

function mount(node: ReactElement): void {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);
  act(() => root.render(node));
}

function findByTestId(id: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  if (!el) throw new Error(`testid not found: ${id}`);

  return el;
}

async function clickAndSettle(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("MatchDialog.bind (ADR-129 T6.2 — behavioral)", () => {
  it("POSTs the picked candidate to /mcp/bindings and fires onDone + onClose", async () => {
    stubFetch();
    const onClose = vi.fn();
    const onDone = vi.fn();

    mount(
      createElement(MatchDialog, {
        slug: "proj",
        refId: "github",
        // First candidate is pre-selected.
        candidates: [
          { targetKind: "platform", targetId: "github", transport: "stdio" },
          { targetKind: "project", targetId: "row-1", transport: "stdio" },
        ],
        onClose,
        onDone,
      }),
    );

    await clickAndSettle(findByTestId("mcp-match-confirm"));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/projects/proj/mcp/bindings");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({
      refId: "github",
      targetKind: "platform",
      targetId: "github",
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("OverlayDialog.save (ADR-129 W-C — behavioral)", () => {
  it("PATCHes the binding overlay, preserving the slot NAME, then closes", async () => {
    stubFetch();
    const onClose = vi.fn();
    const onDone = vi.fn();
    const binding: McpBindingView = {
      refId: "github",
      targetKind: "platform",
      targetId: "github",
      enabled: true,
      configOverlay: { envRemap: { GITHUB_TOKEN: "env:PROJ_A_TOKEN" } },
      recommendedHint: null,
    };

    mount(
      createElement(OverlayDialog, {
        slug: "proj",
        binding,
        slots: { env: ["GITHUB_TOKEN"], header: [] },
        onClose,
        onDone,
      }),
    );

    await clickAndSettle(findByTestId("mcp-overlay-save"));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/projects/proj/mcp/bindings/github");
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].body).toEqual({
      configOverlay: { envRemap: { GITHUB_TOKEN: "env:PROJ_A_TOKEN" } },
    });
    // ADR-179: the KEY is the server's contract and is preserved; the VALUE is
    // what the overlay replaces.
    expect(
      Object.keys(
        (calls[0].body as { configOverlay: { envRemap: object } }).configOverlay
          .envRemap,
      ),
    ).toEqual(["GITHUB_TOKEN"]);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sends a bearerTokenEnv override for an http/sse target", async () => {
    stubFetch();
    const binding: McpBindingView = {
      refId: "remote",
      targetKind: "platform",
      targetId: "remote",
      enabled: true,
      configOverlay: {},
      recommendedHint: null,
    };

    mount(
      createElement(OverlayDialog, {
        slug: "proj",
        binding,
        slots: { env: [], header: [], transport: "http" },
        onClose: vi.fn(),
        onDone: vi.fn(),
      }),
    );

    const bearer = findByTestId("mcp-overlay-bearer") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;

    act(() => {
      setter.call(bearer, "env:PROJ_A_TOKEN");
      bearer.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await clickAndSettle(findByTestId("mcp-overlay-save"));

    expect(calls[0].body).toEqual({
      configOverlay: { bearerTokenEnv: "env:PROJ_A_TOKEN" },
    });
  });

  it("hides the bearer override for a stdio target — the field does not exist there", async () => {
    stubFetch();

    mount(
      createElement(OverlayDialog, {
        slug: "proj",
        binding: {
          refId: "github",
          targetKind: "platform",
          targetId: "github",
          enabled: true,
          configOverlay: {},
          recommendedHint: null,
        },
        slots: { env: ["GITHUB_TOKEN"], header: [], transport: "stdio" },
        onClose: vi.fn(),
        onDone: vi.fn(),
      }),
    );

    expect(
      document.body.querySelector('[data-testid="mcp-overlay-bearer"]'),
    ).toBeNull();
  });

  it("warns on a LITERAL under a secret-shaped slot without blocking the save", async () => {
    stubFetch();

    mount(
      createElement(OverlayDialog, {
        slug: "proj",
        binding: {
          refId: "github",
          targetKind: "platform",
          targetId: "github",
          enabled: true,
          // D32: overlay values share the server grammar, so a literal is a
          // legitimate override — warned, never refused.
          configOverlay: { envRemap: { GITHUB_TOKEN: "ghp_literal" } },
          recommendedHint: null,
        },
        slots: { env: ["GITHUB_TOKEN"], header: [], transport: "stdio" },
        onClose: vi.fn(),
        onDone: vi.fn(),
      }),
    );

    expect(document.body.querySelector('[role="note"]')?.textContent).toBe(
      "secretShapedWarning",
    );

    await clickAndSettle(findByTestId("mcp-overlay-save"));

    expect(calls[0].body).toEqual({
      configOverlay: { envRemap: { GITHUB_TOKEN: "ghp_literal" } },
    });
  });
});
