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
  it("PATCHes the binding overlay with env:NAME references only, then closes", async () => {
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
    // The secret invariant: only the env:NAME reference is sent, never a value.
    expect(JSON.stringify(calls[0].body)).toContain("env:PROJ_A_TOKEN");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
