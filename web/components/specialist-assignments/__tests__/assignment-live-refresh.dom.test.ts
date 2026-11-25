// @vitest-environment jsdom

import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { router, stream } = vi.hoisted(() => ({
  router: { refresh: vi.fn() },
  stream: {
    eventCount: 0,
    liveness: "live" as
      "connecting" | "live" | "reconnecting" | "disconnected" | "closed",
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));
vi.mock("@/lib/use-run-stream", () => ({
  useRunStream: () => stream,
}));

import { AssignmentLiveRefresh } from "@/components/specialist-assignments/assignment-live-refresh";

type Props = ComponentProps<typeof AssignmentLiveRefresh>;

const fetchMock = vi.fn<typeof fetch>();
const baseProps: Props = {
  assignmentId: "asgn-1",
  revision: 1,
  runId: "run-1",
};

let root: Root;
let container: HTMLDivElement;

function render(props: Props = baseProps): void {
  act(() => root.render(createElement(AssignmentLiveRefresh, props)));
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock
    .mockReset()
    .mockImplementation(async () => Response.json({ revision: 2 }));
  router.refresh.mockReset();
  stream.eventCount = 0;
  stream.liveness = "live";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AssignmentLiveRefresh", () => {
  it("completes the scheduled refresh and calls router.refresh() even when SSE immediately transitions live to reconnecting", async () => {
    render();
    stream.eventCount = 1;
    render();

    // Terminal SSE close flips liveness out of "live" before the 750ms coalesce window fires.
    stream.liveness = "reconnecting";
    render();

    await advance(750);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/specialist-assignments/asgn-1",
    );
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("resets the unavailable status when assignmentId or runId changes", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    render();
    stream.eventCount = 1;
    render();
    await advance(750);

    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "specialistAssignments.progressUnavailable",
    );

    render({ ...baseProps, runId: "run-2" });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
