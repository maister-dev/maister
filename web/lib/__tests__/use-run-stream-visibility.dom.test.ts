// @vitest-environment jsdom

import type { UseRunStreamResult } from "@/lib/use-run-stream";
import type { Root } from "react-dom/client";

import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRunStream } from "@/lib/use-run-stream";

class MockRunEventSource {
  static instances: MockRunEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    MockRunEventSource.instances.push(this);
  }

  emit(payload: Record<string, unknown>, lastEventId = ""): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify(payload),
        lastEventId,
      }),
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

let latest: UseRunStreamResult | null = null;

function Harness({
  runId,
  retain,
  onSnapshot,
}: {
  runId: string | null;
  retain: boolean;
  onSnapshot: (value: UseRunStreamResult) => void;
}) {
  const value = useRunStream(runId, { retain });

  useEffect(() => {
    onSnapshot(value);
  });

  return createElement("output", null, String(value.eventCount));
}

function renderHarness(runId: string | null, retain: boolean): void {
  root.render(
    createElement(Harness, {
      runId,
      retain,
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
  vi.stubGlobal("EventSource", MockRunEventSource);
  MockRunEventSource.instances = [];
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

describe("useRunStream visibility pause/resume", () => {
  it("pauses tick-only streams while hidden without backoff and resumes with lastEventId plus one catch-up tick", () => {
    act(() => renderHarness("run-1", false));
    expect(MockRunEventSource.instances).toHaveLength(1);
    const first = MockRunEventSource.instances[0];

    act(() => first.onopen?.());
    expect(latest?.eventCount).toBe(0);
    expect(latest?.liveness).toBe("live");

    act(() => first.emit({ type: "session.update", runSequence: "42" }, "42"));
    expect(latest?.eventCount).toBe(1);
    expect(latest?.lastEventId).toBe("42");

    // Hiding closes the active EventSource without triggering error state or backoff.
    act(() => transitionVisibility("hidden"));
    expect(first.close).toHaveBeenCalledOnce();
    expect(latest?.error).toBeNull();

    // No reconnect timers fire while hidden.
    act(() => vi.advanceTimersByTime(60_000));
    expect(MockRunEventSource.instances).toHaveLength(1);

    // Returning to visible reconnects with lastEventId and fires one catch-up tick on open.
    act(() => transitionVisibility("visible"));
    expect(MockRunEventSource.instances).toHaveLength(2);
    const resumed = MockRunEventSource.instances[1];
    const resumedParams = new URL(resumed.url).searchParams;

    expect(resumedParams.get("lastEventId")).toBe("42");
    expect(resumedParams.get("replay")).toBe("0");
    expect(latest?.eventCount).toBe(1);

    act(() => resumed.onopen?.());
    expect(latest?.eventCount).toBe(2);
    expect(latest?.liveness).toBe("live");

    // Synthetic session.stream_ready right after visibility-resume open does not double-tick.
    act(() => resumed.emit({ type: "session.stream_ready", replay: false }));
    expect(latest?.eventCount).toBe(2);

    // Verify a pending error reconnect timer is cancelled on hide without incrementing backoff.
    act(() => resumed.onerror?.());
    expect(latest?.liveness).toBe("reconnecting");
    act(() => vi.advanceTimersByTime(250));
    act(() => transitionVisibility("hidden"));
    act(() => vi.advanceTimersByTime(10_000));
    expect(MockRunEventSource.instances).toHaveLength(2);

    act(() => transitionVisibility("visible"));
    expect(MockRunEventSource.instances).toHaveLength(3);
    const third = MockRunEventSource.instances[2];

    act(() => third.onerror?.());
    // Initial backoff is 500ms (not 1000ms), proving backoff was reset on visibility pause.
    act(() => vi.advanceTimersByTime(499));
    expect(MockRunEventSource.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(MockRunEventSource.instances).toHaveLength(4);
  });

  it("leaves retain: true replay streams unaffected by visibility changes", () => {
    act(() => renderHarness("run-2", true));
    expect(MockRunEventSource.instances).toHaveLength(1);
    const source = MockRunEventSource.instances[0];

    act(() => source.onopen?.());
    act(() => source.emit({ type: "session.update", runSequence: "7" }, "7"));
    expect(latest?.eventCount).toBe(1);
    expect(latest?.events).toHaveLength(1);

    act(() => transitionVisibility("hidden"));
    expect(source.close).not.toHaveBeenCalled();

    act(() => transitionVisibility("visible"));
    expect(MockRunEventSource.instances).toHaveLength(1);
    expect(latest?.eventCount).toBe(1);
    expect(latest?.events).toHaveLength(1);
  });

  it("opens zero EventSources when mounted while hidden and connects on visible", () => {
    setVisibilityState("hidden");
    act(() => renderHarness("run-hidden", false));
    expect(MockRunEventSource.instances).toHaveLength(0);

    act(() => transitionVisibility("visible"));
    expect(MockRunEventSource.instances).toHaveLength(1);
    expect(new URL(MockRunEventSource.instances[0].url).pathname).toBe(
      "/api/runs/run-hidden/stream",
    );
  });

  it("resets liveness, retry budget, error, cursor, and events cleanly when switching runId from A to B", () => {
    act(() => renderHarness("run-1", true));
    const first = MockRunEventSource.instances[0];

    act(() => first.onopen?.());
    act(() => first.emit({ type: "session.update", runSequence: "9" }, "9"));
    expect(latest?.events).toHaveLength(1);
    expect(latest?.lastEventId).toBe("9");

    // Exhaust all 3 automatic retries on run-1 so it reaches "disconnected".
    act(() => MockRunEventSource.instances.at(-1)?.onerror?.());
    act(() => vi.advanceTimersByTime(500));
    act(() => MockRunEventSource.instances.at(-1)?.onerror?.());
    act(() => vi.advanceTimersByTime(1000));
    act(() => MockRunEventSource.instances.at(-1)?.onerror?.());
    act(() => vi.advanceTimersByTime(2000));
    act(() => MockRunEventSource.instances.at(-1)?.onerror?.());

    expect(latest?.liveness).toBe("disconnected");
    expect(latest?.error).toBe("eventsource error");

    const countBeforeSwitch = MockRunEventSource.instances.length;

    // Switching to run-2 must reset state and grant a full automatic retry budget.
    act(() => renderHarness("run-2", true));
    expect(MockRunEventSource.instances).toHaveLength(countBeforeSwitch + 1);
    expect(latest?.liveness).toBe("connecting");
    expect(latest?.error).toBeNull();
    expect(latest?.lastEventId).toBeNull();
    expect(latest?.events).toHaveLength(0);
    expect(latest?.eventCount).toBe(0);

    const run2Source = MockRunEventSource.instances.at(-1)!;

    expect(new URL(run2Source.url).searchParams.get("lastEventId")).toBeNull();

    // First error on run-2 enters "reconnecting" and schedules the 500ms retry.
    act(() => run2Source.onerror?.());
    expect(latest?.liveness).toBe("reconnecting");
    act(() => vi.advanceTimersByTime(500));
    expect(MockRunEventSource.instances).toHaveLength(countBeforeSwitch + 2);
  });
});
