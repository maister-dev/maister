// @vitest-environment jsdom

import type { WorkbenchStream } from "@/lib/use-run-workbench-stream";
import type { Root } from "react-dom/client";

import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRunWorkbenchStream } from "@/lib/use-run-workbench-stream";

class MockWorkbenchEventSource {
  static instances: MockWorkbenchEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    MockWorkbenchEventSource.instances.push(this);
  }

  emit(payload: Record<string, unknown>): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    );
  }
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
}

function transitionVisibility(state: DocumentVisibilityState): void {
  setVisibilityState(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

let latest: WorkbenchStream | null = null;

function Harness({
  anchor,
  selected,
  onSnapshot,
}: {
  anchor: string;
  selected: string | null;
  onSnapshot: (value: WorkbenchStream) => void;
}) {
  const value = useRunWorkbenchStream(anchor, selected);

  useEffect(() => {
    onSnapshot(value);
  });

  return createElement("output", null, value.main.liveness);
}

function renderHarness(anchor: string, selected: string | null): void {
  root.render(
    createElement(Harness, {
      anchor,
      selected,
      onSnapshot: (value) => {
        latest = value;
      },
    }),
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", MockWorkbenchEventSource);
  MockWorkbenchEventSource.instances = [];
  latest = null;
  setVisibilityState("visible");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (document as { visibilityState?: DocumentVisibilityState })
    .visibilityState;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useRunWorkbenchStream", () => {
  it("opens zero sockets when mounted hidden and opens one socket on show", () => {
    setVisibilityState("hidden");
    act(() => renderHarness("run-1", null));
    expect(MockWorkbenchEventSource.instances).toHaveLength(0);

    // Calling reconnect while hidden still opens zero sockets.
    act(() => latest?.main.reconnect());
    expect(MockWorkbenchEventSource.instances).toHaveLength(0);

    act(() => transitionVisibility("visible"));
    expect(MockWorkbenchEventSource.instances).toHaveLength(1);
    expect(MockWorkbenchEventSource.instances[0].url).toBe(
      "/api/runs/run-1/peek/stream",
    );
  });

  it("closes on hide, opens one socket on show, and treats onShow as idempotent on a live socket", () => {
    act(() => renderHarness("run-1", "child-1"));
    expect(MockWorkbenchEventSource.instances).toHaveLength(1);
    const first = MockWorkbenchEventSource.instances[0];

    act(() =>
      first.emit({
        type: "peek.ready",
        anchorRunId: "run-1",
        selectedRunId: "child-1",
        selectionState: "ready",
      }),
    );
    expect(latest?.main.liveness).toBe("live");

    // Redundant visible event must not tear down or duplicate the active socket.
    act(() => transitionVisibility("visible"));
    expect(MockWorkbenchEventSource.instances).toHaveLength(1);
    expect(first.close).not.toHaveBeenCalled();

    // Hiding closes the socket and cancels reconnect activity.
    act(() => transitionVisibility("hidden"));
    expect(first.close).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(60_000));
    expect(MockWorkbenchEventSource.instances).toHaveLength(1);

    // Returning to visible opens exactly one fresh socket.
    act(() => transitionVisibility("visible"));
    expect(MockWorkbenchEventSource.instances).toHaveLength(2);
    expect(MockWorkbenchEventSource.instances[1].url).toBe(
      "/api/runs/run-1/peek/stream?selected=child-1",
    );
  });

  it("suppresses hidden onerror reconnects without flipping liveness to reconnecting or disconnected", () => {
    act(() => renderHarness("run-1", null));
    const first = MockWorkbenchEventSource.instances[0];

    act(() =>
      first.emit({
        type: "peek.ready",
        anchorRunId: "run-1",
        selectedRunId: null,
        selectionState: "none",
      }),
    );
    expect(latest?.main.liveness).toBe("live");

    // Document turns hidden before an error arrives on the socket.
    setVisibilityState("hidden");
    act(() => first.onerror?.());
    expect(first.close).toHaveBeenCalledOnce();
    expect(latest?.main.liveness).toBe("live");
    expect(latest?.main.error).toBeNull();

    act(() => vi.advanceTimersByTime(60_000));
    expect(MockWorkbenchEventSource.instances).toHaveLength(1);

    act(() => transitionVisibility("visible"));
    expect(MockWorkbenchEventSource.instances).toHaveLength(2);
  });

  it("resets the retry budget on peek.ready so more than 3 transient disconnects across healthy connects never stick in disconnected", () => {
    act(() => renderHarness("run-1", null));

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const source = MockWorkbenchEventSource.instances.at(-1)!;

      act(() =>
        source.emit({
          type: "peek.ready",
          anchorRunId: "run-1",
          selectedRunId: null,
          selectionState: "none",
        }),
      );
      expect(latest?.main.liveness).toBe("live");

      const beforeErrorCount = MockWorkbenchEventSource.instances.length;

      act(() => source.onerror?.());
      expect(latest?.main.liveness).toBe("reconnecting");

      // Because peek.ready reset attempts to 0, each disconnect waits only 500ms.
      act(() => vi.advanceTimersByTime(499));
      expect(MockWorkbenchEventSource.instances).toHaveLength(beforeErrorCount);
      act(() => vi.advanceTimersByTime(1));
      expect(MockWorkbenchEventSource.instances).toHaveLength(
        beforeErrorCount + 1,
      );
    }

    expect(latest?.main.liveness).not.toBe("disconnected");
  });

  it("resets the retry budget when selected changes", () => {
    act(() => renderHarness("run-1", "child-1"));

    // Exhaust all 3 automatic retries on child-1 so liveness sticks in disconnected.
    act(() => MockWorkbenchEventSource.instances.at(-1)?.onerror?.());
    act(() => vi.advanceTimersByTime(500));
    act(() => MockWorkbenchEventSource.instances.at(-1)?.onerror?.());
    act(() => vi.advanceTimersByTime(1000));
    act(() => MockWorkbenchEventSource.instances.at(-1)?.onerror?.());
    act(() => vi.advanceTimersByTime(2000));
    act(() => MockWorkbenchEventSource.instances.at(-1)?.onerror?.());
    expect(latest?.main.liveness).toBe("disconnected");

    const countBeforeSwitch = MockWorkbenchEventSource.instances.length;

    // Switching selected run resets state and grants a fresh retry budget.
    act(() => renderHarness("run-1", "child-2"));
    expect(MockWorkbenchEventSource.instances).toHaveLength(
      countBeforeSwitch + 1,
    );
    expect(latest?.main.liveness).toBe("connecting");
    expect(latest?.main.error).toBeNull();

    const child2Source = MockWorkbenchEventSource.instances.at(-1)!;

    act(() => child2Source.onerror?.());
    expect(latest?.main.liveness).toBe("reconnecting");
    act(() => vi.advanceTimersByTime(500));
    expect(MockWorkbenchEventSource.instances).toHaveLength(
      countBeforeSwitch + 2,
    );
  });
});
