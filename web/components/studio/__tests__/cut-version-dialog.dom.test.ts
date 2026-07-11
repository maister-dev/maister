// @vitest-environment jsdom

// ADR-129 §c (T16): the cut dialog POSTs `adoptInProjectIds` ONLY for the
// explicitly checked projects (default none — never background adoption),
// renders per-project adopt outcomes as glyphs, and retries ONLY the failed
// projects (the cut is content-addressed, so the re-POST re-uses the install).

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) =>
    (key: string): string =>
      `${namespace}.${key}`,
}));

import { CutVersionDialog } from "@/components/studio/cut-version-dialog";

const roots: Root[] = [];
const fetchMock = vi.fn();

const TARGETS = [
  { projectId: "p1", name: "Proj One" },
  { projectId: "p2", name: "Proj Two" },
];

function render(onCut = vi.fn()): HTMLElement {
  const host = document.createElement("div");

  document.body.appendChild(host);
  const root = createRoot(host);

  roots.push(root);
  act(() => {
    root.render(
      createElement(CutVersionDialog, {
        packageId: "lp1",
        packageName: "demo",
        adoptTargets: TARGETS,
        onClose: vi.fn(),
        onCut,
      }),
    );
  });

  return host;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
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

describe("CutVersionDialog", () => {
  it("default cut sends an EMPTY body — no background adoption", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ installId: "i1", versionLabel: "local-aaa" }),
    );
    const host = render();

    await click(host.querySelector('[data-testid="cut-dialog-submit"]')!);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/studio/local-packages/lp1/cut-version",
      expect.objectContaining({ method: "POST", body: JSON.stringify({}) }),
    );
  });

  it("checked projects go into adoptInProjectIds; results render per project with glyph testids", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        installId: "i1",
        versionLabel: "local-aaa",
        adoptions: [
          { projectId: "p1", status: "adopted" },
          { projectId: "p2", status: "failed", error: "worktree busy" },
        ],
      }),
    );
    const onCut = vi.fn();
    const host = render(onCut);

    await click(host.querySelector('[data-testid="cut-adopt-check-p1"]')!);
    await click(host.querySelector('[data-testid="cut-adopt-check-p2"]')!);
    await click(host.querySelector('[data-testid="cut-dialog-submit"]')!);

    const body = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );

    expect(body).toEqual({ adoptInProjectIds: ["p1", "p2"] });
    expect(onCut).toHaveBeenCalledWith("local-aaa");
    expect(
      host.querySelector('[data-testid="cut-adopt-adopted"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-testid="cut-adopt-failed"]')?.textContent,
    ).toContain("worktree busy");

    // Retry re-POSTs ONLY the failed project.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        installId: "i1",
        versionLabel: "local-aaa",
        adoptions: [{ projectId: "p2", status: "adopted" }],
      }),
    );
    await click(host.querySelector('[data-testid="cut-retry-failed"]')!);

    const retryBody = JSON.parse(
      (fetchMock.mock.calls[1]![1] as RequestInit).body as string,
    );

    expect(retryBody).toEqual({ adoptInProjectIds: ["p2"] });
  });
});
