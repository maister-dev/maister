// @vitest-environment jsdom

import type { ComponentProps } from "react";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const stream = vi.hoisted(() => ({
  eventCount: 0,
  liveness: "connecting",
  reconnect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/runs/run-stream-provider", () => ({
  useRunPageStream: () => stream,
}));

import { RunLiveRefresh } from "@/components/runs/run-live-refresh";

type Props = ComponentProps<typeof RunLiveRefresh>;

const fetchMock = vi.fn<typeof fetch>();
const initialProps: Props = {
  runId: "run-1",
  runStatus: "NeedsInput",
  currentStepId: "intake",
  livenessLabels: {
    disconnected: "Disconnected",
    live: "Live",
    reconnect: "Reconnect",
    reconnecting: "Reconnecting",
  },
};
let root: Root;

function render(props: Props = initialProps): void {
  act(() => root.render(createElement(RunLiveRefresh, props)));
}

async function advance(ms: number): Promise<void> {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

function tick(props: Props = initialProps): void {
  stream.eventCount += 1;
  render(props);
}

function snapshot(runStatus = "Running", currentStepId = "survey"): Response {
  return Response.json({ runStatus, currentStepId });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async () => snapshot());
  router.refresh.mockReset();
  stream.eventCount = 0;
  stream.liveness = "connecting";
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RunLiveRefresh", () => {
  it("refreshes a resumed run while chunks keep arriving without a quiet gap", async () => {
    render();
    tick();
    for (let chunk = 0; chunk < 4; chunk += 1) {
      await advance(200);
      tick();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(router.refresh).toHaveBeenCalledTimes(1);

    for (let chunk = 0; chunk < 8; chunk += 1) {
      await advance(200);
      tick();
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes a retained sidebar on connection even when the run page already has current props", async () => {
    const props = {
      ...initialProps,
      runStatus: "Running",
      currentStepId: "survey",
    };

    render(props);
    stream.liveness = "live";
    render(props);
    await advance(800);

    expect(router.refresh).toHaveBeenCalledTimes(1);
    await advance(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    tick(props);
    await advance(800);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("serializes slow checks and retains a tick received while a check is in flight", async () => {
    let resolveFirst!: (response: Response) => void;

    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    render();
    tick();
    await advance(800);
    tick();
    await advance(1600);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => resolveFirst(snapshot("NeedsInput", "intake")));
    await advance(800);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores an old run's response after navigation and cancels pending work at terminal status", async () => {
    let resolveFirst!: (response: Response) => void;

    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    render();
    tick();
    await advance(800);
    const signal = fetchMock.mock.calls[0][1]?.signal;

    render({ ...initialProps, runId: "run-2" });
    expect(signal?.aborted).toBe(true);
    await act(async () => resolveFirst(snapshot()));
    expect(router.refresh).not.toHaveBeenCalled();

    render({ ...initialProps, runId: "run-2", runStatus: "Done" });
    await advance(1600);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
