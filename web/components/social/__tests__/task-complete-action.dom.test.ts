// @vitest-environment jsdom

import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskCompleteAction } from "@/components/social/task-complete-action";

const { router } = vi.hoisted(() => ({
  router: { refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(TaskCompleteAction, {
        slug: "fuse project",
        taskNumber: 1,
        expectedRevision: 7,
        labels: {
          complete: "Complete task",
          completing: "Completing…",
          error: "Could not complete",
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

describe("TaskCompleteAction", () => {
  it("posts the expected revision and refreshes after success", async () => {
    const fetchMock = vi.fn(async () => Response.json({ status: "Done" }));
    vi.stubGlobal("fetch", fetchMock);

    const button = container.querySelector("button");

    expect(button?.textContent).toContain("Complete task");
    await act(async () => button?.click());

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/fuse%20project/tasks/1/complete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedRevision: 7 }),
      }),
    );
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("shows the API error without refreshing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { message: "latest flow run has not been delivered" },
          { status: 409 },
        ),
      ),
    );

    await act(async () => container.querySelector("button")?.click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not complete",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
