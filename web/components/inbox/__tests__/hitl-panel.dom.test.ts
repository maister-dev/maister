// @vitest-environment jsdom

// `T-D16` (`AC-D16`) — the panel fetches `inbox-context` on FIRST EXPAND only.
//
// This is the guard against the Desk firing one request per `WaitingOnHuman` row
// on page load. The Desk may hold many such rows, and a mount-time fetch would
// be invisible in review and obvious in production.
//
// It lives in jsdom rather than Playwright on purpose: this is the lane CI runs.
// The plan originally routed it to e2e on the belief that vitest has no DOM —
// it does, per-file, and 28 other suites in this repo already use it.

import type { HitlItem } from "@/lib/queries/hitl";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One translator per namespace — a fresh function per render is a changing
// `useCallback`/`useEffect` dep, and this component's effects depend on one.
const { translators } = vi.hoisted(() => ({
  translators: new Map<string, (key: string) => string>(),
}));

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => {
    const cached = translators.get(namespace);

    if (cached) return cached;

    const translate = (key: string): string => `${namespace}.${key}`;

    translators.set(namespace, translate);

    return translate;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { HitlPanel } from "@/components/inbox/hitl-panel";

const ITEM: HitlItem = {
  hitlRequestId: "h1",
  runId: "run-7",
  runKind: "flow",
  kind: "human",
  answerState: "open",
  storedResponse: null,
  assignmentId: null,
  assignmentStatus: null,
  assignmentActionKind: null,
  assignmentRoleRefs: [],
  assignmentStaleEvidenceSummary: null,
  assigneeLabel: null,
  assigneeUserId: null,
  agent: "claude",
  branch: "maister/feature-x",
  flowRef: "bugfix",
  stage: { label: "review", type: "human" },
  taskRef: "ACME-12",
  taskTitle: "Refactor session store",
  prompt: "Ready for review?",
  options: [],
  time: "2h",
  createdAt: "2026-07-02T10:00:00.000Z",
  schema: null,
  criticality: "low",
};

const CONTEXT = {
  gates: [],
  diff: null,
  budgetProgress: null,
  claimStage: null,
  availableOptions: null,
};

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function mount(expanded: boolean): void {
  act(() => {
    root.render(
      createElement(HitlPanel, {
        canAct: true,
        currentUserId: "u1",
        expanded,
        item: ITEM,
      }),
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => CONTEXT,
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("T-D16 the panel fetches on first expand only", () => {
  it("issues no request while collapsed", async () => {
    mount(false);
    await act(async () => {});

    // The failure this forbids: one request per WaitingOnHuman row on page load.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("issues exactly one request when the parent expands it", async () => {
    mount(false);
    await act(async () => {});
    mount(true);
    await act(async () => {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-7/inbox-context");
  });

  it("does not re-fetch when the parent re-renders it still expanded", async () => {
    mount(false);
    await act(async () => {});
    mount(true);
    await act(async () => {});
    mount(true);
    await act(async () => {});

    // A re-render is not a new question. Without the guard, every parent state
    // change on the Desk would re-request every open panel.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders the loading branch while the request is in flight", async () => {
    let settle: (value: unknown) => void = () => {};

    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );

    mount(false);
    await act(async () => {});
    mount(true);

    // Deliberately observed BEFORE the promise settles: a panel that showed
    // nothing here would look broken on a slow run.
    expect(container.textContent).toContain("inbox.contextLoading");

    await act(async () => {
      settle({ ok: true, json: async () => CONTEXT });
    });

    expect(container.textContent).not.toContain("inbox.contextLoading");
  });

  it("renders the error branch when the request fails, and does not retry itself", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      json: async () => ({}),
    }));

    mount(false);
    await act(async () => {});
    mount(true);
    await act(async () => {});

    expect(container.textContent).toContain("inbox.contextError");
    // Retry is the reader's decision — an automatic one would hammer a failing
    // endpoint once per open panel.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
