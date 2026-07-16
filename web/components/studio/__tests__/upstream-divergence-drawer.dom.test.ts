// @vitest-environment jsdom

// ADR-132 (T18): drawer states — a CONFIG refusal (GC'd/unlinked source)
// renders the DEGRADED panel (not a generic failure), an empty divergence
// renders the clean note, and the cut picker re-queries with cutInstallId.

import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => {
  // Match use-intl's memoized translator identity across rerenders.
  const translators = new Map<string, (key: string) => string>();

  return {
    useTranslations: (namespace: string): ((key: string) => string) => {
      const existing = translators.get(namespace);

      if (existing) return existing;
      const translate = (key: string): string => `${namespace}.${key}`;

      translators.set(namespace, translate);

      return translate;
    },
  };
});
vi.mock("@/components/workbench/diff-view", () => ({
  DiffView: () => createElement("div", { "data-testid": "diff-view-stub" }),
}));

import { UpstreamDivergenceDrawer } from "@/components/studio/upstream-divergence-drawer";

const roots: Root[] = [];
const fetchMock = vi.fn();

const DIFF_LABELS = {} as never;

function render(element: string | null = null): HTMLElement {
  const host = document.createElement("div");

  document.body.appendChild(host);
  const root = createRoot(host);

  roots.push(root);
  act(() => {
    root.render(
      createElement(UpstreamDivergenceDrawer, {
        packageId: "lp1",
        cuts: [{ installId: "inst-c1", versionLabel: "local-abc123def456" }],
        element,
        diffViewLabels: DIFF_LABELS,
        onClose: vi.fn(),
      }),
    );
  });

  return host;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CLEAN_DTO = {
  files: [],
  perFile: [],
  truncated: false,
  changedCount: 0,
  base: { installId: "inst-src", versionLabel: "pkg/v1.0.0" },
  compared: { kind: "working_dir" },
};

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
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

describe("UpstreamDivergenceDrawer", () => {
  it("renders the clean note + base label for an empty divergence", async () => {
    fetchMock.mockResolvedValue(jsonResponse(CLEAN_DTO));
    const host = render();

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/studio/local-packages/lp1/divergence",
    );
    expect(
      host.querySelector('[data-testid="divergence-clean"]'),
    ).not.toBeNull();
    expect(
      host.querySelector('[data-testid="divergence-base"]')?.textContent,
    ).toContain("studio.divergence.base");
  });

  it("renders the DEGRADED panel on a CONFIG refusal (source unavailable)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { code: "CONFIG", message: "source install unavailable: x" },
        422,
      ),
    );
    const host = render();

    await flush();

    expect(
      host.querySelector('[data-testid="divergence-degraded"]'),
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="divergence-error"]')).toBeNull();
  });

  it("renders the DiffView for a non-empty divergence and re-queries with the picked cut", async () => {
    // Fresh Response per call — a Response body is single-use.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          ...CLEAN_DTO,
          changedCount: 1,
          files: [
            { path: "flows/a.yaml", status: "M", additions: 1, deletions: 1 },
          ],
        }),
      ),
    );
    const host = render();

    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="diff-view-stub"]')).not.toBeNull();

    const select = host.querySelector(
      '[data-testid="divergence-source-select"]',
    ) as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set;

    await act(async () => {
      setter?.call(select, "inst-c1");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/studio/local-packages/lp1/divergence?cutInstallId=inst-c1",
    );
  });

  it("threads the element scope into the query", async () => {
    fetchMock.mockResolvedValue(jsonResponse(CLEAN_DTO));
    render("skills/my-skill");

    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/studio/local-packages/lp1/divergence?element=skills%2Fmy-skill",
    );
  });
});
