// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskSourceDetach } from "@/components/tasks/task-source-detach";

const { router } = vi.hoisted(() => ({
  router: { refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

let root: Root;
let container: HTMLDivElement;

function trigger(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="task-source-detach"]',
  )!;
}

function dialog(): HTMLElement | null {
  return document.querySelector('[data-testid="task-source-detach-confirm"]');
}

function submit(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(
    '[data-testid="task-source-detach-submit"]',
  )!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(TaskSourceDetach, {
        slug: "fuse project",
        taskNumber: 7,
        labels: {
          detach: "Detach source",
          title: "Detach the external source?",
          body: "The external item can be imported again.",
          cancel: "Cancel",
          confirm: "Detach",
          detaching: "Detaching…",
          error: "Could not detach",
        },
      }),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("TaskSourceDetach", () => {
  it("asks for confirmation before sending anything", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));

    vi.stubGlobal("fetch", fetchMock);

    expect(trigger().getAttribute("aria-label")).toBe("Detach source");
    expect(dialog()).toBeNull();

    await act(async () => trigger().click());

    expect(dialog()?.textContent).toContain("Detach the external source?");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes the binding and refreshes after confirmation", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));

    vi.stubGlobal("fetch", fetchMock);

    await act(async () => trigger().click());
    await act(async () => submit().click());

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/fuse%20project/tasks/7/source",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(dialog()).toBeNull();
  });

  it("keeps the dialog open with a localized error when the detach is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "PRECONDITION", message: "source_not_bound" },
          { status: 409 },
        ),
      ),
    );

    await act(async () => trigger().click());
    await act(async () => submit().click());

    const alert = dialog()?.querySelector('[role="alert"]');

    expect(alert?.textContent).toBe("Could not detach");
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
