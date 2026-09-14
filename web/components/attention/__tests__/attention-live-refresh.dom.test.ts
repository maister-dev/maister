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
