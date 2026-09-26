// @vitest-environment jsdom

import type { AttentionTickFrame } from "@/lib/use-attention-stream";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttentionLiveRefresh } from "@/components/attention/attention-live-refresh";

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));

class AttentionEventSource extends EventTarget {
  static sources: AttentionEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    super();
    AttentionEventSource.sources.push(this);
  }

  tick(changed: AttentionTickFrame["changed"]): void {
    const frame: AttentionTickFrame = {
      type: "attention.tick",
      id: "1789387200000",
      occurredAt: "2026-09-14T12:00:00.000Z",
      decisions: 1,
      updates: 0,
      changed,
      projectIds: ["project-1"],
    };

    this.dispatchEvent(
      new MessageEvent("attention.tick", {
        data: JSON.stringify(frame),
        lastEventId: frame.id,
      }),
    );
  }
}

const labels = {
  disconnected: "Disconnected",
  live: "Live",
  reconnect: "Reconnect",
  reconnecting: "Reconnecting",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", AttentionEventSource);
  AttentionEventSource.sources = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(AttentionLiveRefresh, { labels })));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("app attention refresh", () => {
  it("refreshes the initial snapshot to close the server-render subscription gap", () => {
    const source = AttentionEventSource.sources[0];

    expect(router.refresh).not.toHaveBeenCalled();
    act(() => source.onopen?.());
    expect(container.textContent).toBe("Live");
    expect(router.refresh).not.toHaveBeenCalled();
    act(() => source.tick([]));
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("refreshes when a pushed decision changes", () => {
    const source = AttentionEventSource.sources[0];

    act(() => source.tick([]));
    act(() => source.tick(["decisions", "work"]));
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  it("preserves the cursor and refreshes changes received after reconnecting", () => {
    const source = AttentionEventSource.sources[0];

    act(() => source.tick([]));
    act(() => source.onerror?.());
    expect(source.close).toHaveBeenCalledOnce();
    expect(container.textContent).toBe("Reconnecting");
    act(() => vi.advanceTimersByTime(500));
    expect(AttentionEventSource.sources).toHaveLength(2);

    const reconnected = AttentionEventSource.sources[1];

    expect(new URL(reconnected.url).searchParams.get("lastEventId")).toBe(
      "1789387200000",
    );
    act(() => reconnected.onopen?.());
    expect(router.refresh).toHaveBeenCalledOnce();
    act(() => reconnected.tick(["decisions", "work", "activity"]));
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });

  // ADR-171 D7: the render is the first cursor. The page's own cursor and
  // counters ride the first connect, so the server can stay silent when the
  // page is current instead of answering with a snapshot this component would
  // refresh on; a reconnect carries the last tick's.
  it("connects with the render's cursor and counters, and reconnects with the last tick's", () => {
    act(() => root.unmount());
    AttentionEventSource.sources = [];
    root = createRoot(container);
    act(() =>
      root.render(
        createElement(AttentionLiveRefresh, {
          labels,
          since: { cursor: "1789387100000", decisions: 2, updates: 5 },
        }),
      ),
    );

    const first = new URL(AttentionEventSource.sources[0].url).searchParams;

    expect(first.get("lastEventId")).toBe("1789387100000");
    expect(first.get("decisions")).toBe("2");
    expect(first.get("updates")).toBe("5");
    act(() => AttentionEventSource.sources[0].onopen?.());
    expect(router.refresh).not.toHaveBeenCalled();

    act(() => AttentionEventSource.sources[0].tick(["decisions"]));
    expect(router.refresh).toHaveBeenCalledOnce();
    act(() => AttentionEventSource.sources[0].onerror?.());
    act(() => vi.advanceTimersByTime(500));

    const again = new URL(AttentionEventSource.sources[1].url).searchParams;

    expect(again.get("lastEventId")).toBe("1789387200000");
    expect(again.get("decisions")).toBe("1");
    expect(again.get("updates")).toBe("0");
  });

  it("does not refresh or resubscribe when props or liveness change without a tick", () => {
    const source = AttentionEventSource.sources[0];

    act(() => source.tick([]));
    act(() =>
      root.render(
        createElement(AttentionLiveRefresh, { labels: { ...labels } }),
      ),
    );
    act(() => source.onopen?.());
    act(() => vi.advanceTimersByTime(60_000));
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(AttentionEventSource.sources).toHaveLength(1);
  });
});
