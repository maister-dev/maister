// @vitest-environment jsdom

// ADR-132 §d (T20): the sync UI wiring — an installed target POSTs /sync
// with {sessionId, targetInstallId}; a discovered tag chains install→sync;
// the banner's Resolve carries the optional commit message and Abort posts
// only after confirm.

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) =>
    (key: string): string =>
      `${namespace}.${key}`,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/components/feedback/feedback-provider", () => ({
  useFeedback: () => ({ error: vi.fn(), success: vi.fn() }),
}));

import {
  UpstreamSyncBanner,
  UpstreamSyncButton,
} from "@/components/studio/upstream-sync-controls";

const roots: Root[] = [];
const fetchMock = vi.fn();

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  const host = document.createElement("div");

  document.body.appendChild(host);
  const root = createRoot(host);

  roots.push(root);
  act(() => {
    root.render(element);
  });

  return host;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function pick(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;

  await act(async () => {
    setter?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as RequestInit).body as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("UpstreamSyncButton", () => {
  it("installed target → ONE POST /sync with {sessionId, targetInstallId}", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          outcome: "clean",
          conflictedFiles: [],
          targetInstallId: "inst-2",
          targetRef: "local-bbb",
        }),
      ),
    );
    const host = mount(
      createElement(UpstreamSyncButton, {
        packageId: "lp1",
        sessionId: "s1",
        disabled: false,
        options: {
          targets: [{ installId: "inst-2", versionLabel: "local-bbb" }],
          source: null,
        },
      }),
    );

    await click(host.querySelector('[data-testid="local-editor-sync"]')!);
    await pick(
      host.querySelector('[data-testid="sync-target-select"]')!,
      "inst-2",
    );
    await click(host.querySelector('[data-testid="sync-start"]')!);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/studio/local-packages/lp1/sync",
    );
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({
      sessionId: "s1",
      targetInstallId: "inst-2",
    });
    expect(host.querySelector('[data-testid="sync-target-select"]')).toBeNull();
  });

  it("discovered tag → install THEN sync with the fresh install id", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true, id: "inst-new" }, 201))
      .mockResolvedValueOnce(
        jsonResponse({
          outcome: "conflicted",
          conflictedFiles: ["flows/a.yaml"],
          targetInstallId: "inst-new",
          targetRef: "pkg/v2.0.0",
        }),
      );
    const host = mount(
      createElement(UpstreamSyncButton, {
        packageId: "lp1",
        sessionId: "s1",
        disabled: false,
        options: {
          targets: [],
          source: {
            sourceId: "src-1",
            packageName: "pkg",
            tags: ["pkg/v2.0.0"],
          },
        },
      }),
    );

    await click(host.querySelector('[data-testid="local-editor-sync"]')!);
    await pick(
      host.querySelector('[data-testid="sync-target-select"]')!,
      "install:pkg/v2.0.0",
    );
    await click(host.querySelector('[data-testid="sync-start"]')!);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admin/package-installs");
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({
      sourceId: "src-1",
      name: "pkg",
      version: "pkg/v2.0.0",
    });
    expect(bodyOf(fetchMock.mock.calls[1]!)).toEqual({
      sessionId: "s1",
      targetInstallId: "inst-new",
    });
  });
});

describe("UpstreamSyncBanner", () => {
  const pending = {
    targetInstallId: "inst-2",
    targetRef: "local-bbb",
    conflictedFiles: ["flows/a.yaml"],
  };

  it("Resolve posts /sync/resolve with the optional commit message", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        outcome: "completed",
        conflictedFiles: [],
        targetInstallId: "inst-2",
        targetRef: "local-bbb",
      }),
    );
    const host = mount(
      createElement(UpstreamSyncBanner, {
        packageId: "lp1",
        sessionId: "s1",
        pending,
        disabled: false,
      }),
    );

    expect(
      host.querySelectorAll('[data-testid="sync-conflicted-file"]'),
    ).toHaveLength(1);

    const input = host.querySelector(
      '[data-testid="sync-resolve-message"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;

    await act(async () => {
      setter?.call(input, "merged upstream");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(host.querySelector('[data-testid="sync-resolve"]')!);

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/studio/local-packages/lp1/sync/resolve",
    );
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({
      sessionId: "s1",
      commitMessage: "merged upstream",
    });
  });

  it("Abort sends no request until the shared confirmation is accepted", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const host = mount(
      createElement(UpstreamSyncBanner, {
        packageId: "lp1",
        sessionId: "s1",
        pending,
        disabled: false,
      }),
    );

    await click(host.querySelector('[data-testid="sync-abort"]')!);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[data-testid="sync-abort-confirm"]'),
    ).not.toBeNull();

    await click(
      document.body.querySelector('[data-testid="sync-abort-confirm-cancel"]')!,
    );

    expect(fetchMock).not.toHaveBeenCalled();

    await click(host.querySelector('[data-testid="sync-abort"]')!);
    await click(
      document.body.querySelector('[data-testid="sync-abort-confirm-submit"]')!,
    );

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/studio/local-packages/lp1/sync/abort",
    );
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({ sessionId: "s1" });
    expect(
      document.body.querySelector('[data-testid="sync-abort-confirm"]'),
    ).toBeNull();
  });
});
