// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const feedback = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/components/feedback/feedback-provider", () => ({
  useFeedback: () => feedback,
}));

import { AssignmentLifecycle } from "@/components/specialist-assignments/assignment-lifecycle";
import { AssignmentWork } from "@/components/specialist-assignments/assignment-work";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function mount(element: Parameters<Root["render"]>[0]): HTMLDivElement {
  const container = document.createElement("div");
  const root = createRoot(container);

  document.body.appendChild(container);
  roots.push(root);
  act(() => root.render(element));

  return container;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].filter(
    (candidate) => candidate.textContent?.trim() === name,
  );

  if (!found.length) throw new Error(`No button named ${name}`);

  return found.at(-1)!;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
}

function fill(value: string): void {
  const field = document.querySelector<HTMLTextAreaElement>(
    '[role="dialog"] textarea',
  )!;

  act(() => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function respond(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  router.refresh.mockReset();
  feedback.success.mockReset();
  feedback.error.mockReset();
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("AssignmentLifecycle", () => {
  it("cancels live work through the cancel API and reports pending teardown", async () => {
    respond(202, {
      id: "assignment-1",
      revision: 4,
      status: "active",
      duplicate: false,
    });
    const view = mount(
      createElement(AssignmentLifecycle, {
        assignmentId: "assignment-1",
        revision: 4,
        action: "cancel",
        live: true,
      }),
    );

    expect(view.textContent).toContain("cancelStopsWork");
    await click(button("cancel"));
    fill("Requester withdrew the request.");
    await click(button("cancel"));
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;

    expect(url).toBe("/api/specialist-assignments/assignment-1/cancel");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      expectedRevision: 4,
      reason: "Requester withdrew the request.",
      idempotencyKey: expect.any(String),
    });
    expect(feedback.success).toHaveBeenCalledWith(
      expect.objectContaining({ message: "cancelPending" }),
    );
  });

  it("keeps the dialog open with an error when reopening is refused", async () => {
    respond(409, { code: "CONFLICT", message: "stale" });
    mount(
      createElement(AssignmentLifecycle, {
        assignmentId: "assignment-1",
        revision: 2,
        action: "reopen",
        live: false,
      }),
    );
    await click(button("reopen"));
    fill("Resume the request.");
    await click(button("reopen"));

    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(
      "/api/specialist-assignments/assignment-1/continue",
    );
    expect(
      document.querySelector('[role="dialog"] [role="alert"]'),
    ).not.toBeNull();
    expect(feedback.error).toHaveBeenCalledOnce();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe("AssignmentWork", () => {
  it("offers decisions only on a ready result and posts the exact work revisions", async () => {
    respond(200, {});
    const ready = {
      id: "work-1",
      logicalWorkId: "survey",
      revision: 2,
      inputRevision: 1,
      workRevision: 1,
      state: "result_ready" as const,
      childRunId: "run-1",
      resultRevision: 3,
      limitations: [],
    };

    mount(
      createElement(AssignmentWork, {
        assignmentId: "assignment-1",
        canDecide: true,
        items: [
          ready,
          { ...ready, id: "work-2", state: "running", resultRevision: null },
        ],
      }),
    );

    expect(
      [...document.querySelectorAll("button")].filter(
        (candidate) => candidate.textContent?.trim() === "acceptWork",
      ),
    ).toHaveLength(1);
    await click(button("acceptWork"));
    fill("Matches the expected result.");
    await click(button("acceptWork"));
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;

    expect(url).toBe(
      "/api/specialist-assignments/assignment-1/work/work-1/decisions",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      expectedRevision: 2,
      workRevision: 1,
      inputRevision: 1,
      resultRevision: 3,
      decision: "accept",
    });
  });

  it("shows no decision controls without accept authority", () => {
    const view = mount(
      createElement(AssignmentWork, {
        assignmentId: "assignment-1",
        canDecide: false,
        items: [
          {
            id: "work-1",
            logicalWorkId: "survey",
            revision: 2,
            inputRevision: 1,
            workRevision: 1,
            state: "result_ready",
            childRunId: "run-1",
            resultRevision: 3,
            limitations: [],
          },
        ],
      }),
    );

    expect(view.querySelectorAll("button")).toHaveLength(0);
  });
});
