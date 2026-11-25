// @vitest-environment jsdom

import type { UseRunStreamResult } from "@/lib/use-run-stream";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
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

function Harness({ runId, retain }: { runId: string | null; retain: boolean }) {
  latest = useRunStream(runId, { retain });

  return createElement("output", null, String(latest.eventCount));
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
    act(() =>
      root.render(createElement(Harness, { runId: "run-1", retain: false })),
    );
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
    act(() =>
      root.render(createElement(Harness, { runId: "run-2", retain: true })),
    );
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
});
