// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AutomationsPanel } from "@/components/automations/automations-panel";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const fetchMock = vi.fn();

const labels = {
  all: "All",
  agent: "Agent bindings",
  attention: "Needs attention",
  cancel: "Cancel",
  cancelConfirm: "Cancel this scheduled run?",
  cancelEdit: "Discard",
  disambiguation: "DST choice",
  edit: "Edit",
  earlier: "Earlier offset",
  empty: "No automations",
  error: "Could not update",
  errorLabels: { PRECONDITION: "Needs attention" },
  lateByOne: "Late by __MINUTES__ min",
  lateByOther: "Late by __MINUTES__ min",
  loadMore: "Load more",
  loadingMore: "Loading",
  manageAgent: "Manage agent automation",
  later: "Later offset",
  oneTime: "One-time launches",
  outcomeLabels: { created: "Created" },
  recurring: "Recurring schedules",
  runNow: "Run now",
  save: "Save",
  saving: "Saving",
  scheduledLocalTime: "Local date and time",
  stateLabels: { Scheduled: "Scheduled" },
  timezone: "IANA timezone",
  title: "Automations",
  viewRun: "View Run",
};

const firstRow = {
  id: "intent-1",
  type: "one_time_task_launch" as const,
  name: "Schedule APP-1",
  target: "Patch dependency",
  trigger: "2026-12-01T10:00",
  timezone: "UTC",
  nextActionAt: "2026-12-01T10:00:00.000Z",
  state: "Scheduled",
  latestOutcome: "created",
  errorCode: null,
  errorMessage: null,
  lateByMs: null,
  resultingRun: null,
  detailHref: "/api/projects/demo/automations/one_time_task_launch/intent-1",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function render(
  input: { initialNextCursor?: string | null; rows?: (typeof firstRow)[] } = {},
): HTMLElement {
  const host = document.createElement("div");

  document.body.appendChild(host);
  const root = createRoot(host);

  roots.push(root);
  act(() => {
    root.render(
      createElement(AutomationsPanel, {
        canManage: true,
        initialNextCursor: input.initialNextCursor ?? null,
        initialRows: input.rows ?? [firstRow],
        labels,
        slug: "demo",
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

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );

  if (!button) throw new Error(`button not found: ${text}`);

  return button;
}

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots.length = 0;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("AutomationsPanel interactions", () => {
  it("sends no cancellation request until the portaled confirmation is accepted", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const host = render();

    await click(buttonByText(host, "Cancel"));

    expect(
      document.body.querySelector('[data-testid="automation-cancel-confirm"]'),
    ).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await click(
      buttonByText(
        document.body.querySelector(
          '[data-testid="automation-cancel-confirm"]',
        )!,
        "Discard",
      ),
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels after confirmation and refreshes the first automation page", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { headers: { ETag: '"3"' }, status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ nextCursor: null, rows: [] }), {
          status: 200,
        }),
      );
    const host = render();

    await click(buttonByText(host, "Cancel"));
    await click(
      document.body.querySelector(
        '[data-testid="automation-cancel-confirm-submit"]',
      )!,
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/projects/demo/scheduled-launches/intent-1",
      "/api/projects/demo/scheduled-launches/intent-1/cancel",
      "/api/projects/demo/automations?limit=50",
    ]);
    expect(
      document.body.querySelector('[data-testid="automation-cancel-confirm"]'),
    ).toBeNull();
  });

  it("appends the next cursor page and removes the control at the end", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          nextCursor: null,
          rows: [{ ...firstRow, id: "intent-2", name: "Schedule APP-2" }],
        }),
        { status: 200 },
      ),
    );
    const host = render({ initialNextCursor: "next-a" });

    await click(buttonByText(host, "Load more"));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/demo/automations?limit=50&cursor=next-a",
    );
    expect(host.textContent).toContain("Schedule APP-1");
    expect(host.textContent).toContain("Schedule APP-2");
    expect(host.textContent).not.toContain("Load more");
  });
});
