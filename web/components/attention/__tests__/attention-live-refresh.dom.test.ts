// @vitest-environment jsdom

import type { AttentionTickFrame } from "@/lib/use-attention-stream";
import type { Root } from "react-dom/client";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttentionLiveRefresh } from "@/components/attention/attention-live-refresh";
import {
  AttentionReviewProvider,
  useWatchedReview,
} from "@/components/attention/attention-review-watch";
import { AttentionStreamProvider } from "@/components/attention/attention-stream-provider";
import { TaskLaunchIntentStatus } from "@/components/board/task-launch-intent-status";

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

class AttentionEventSource extends EventTarget {
  static sources: AttentionEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    super();
    AttentionEventSource.sources.push(this);
  }

  tick(
    changed: AttentionTickFrame["changed"],
    overrides?: Partial<
      Pick<
        AttentionTickFrame,
        "id" | "decisions" | "updates" | "reviews" | "reviewVersion"
      >
    >,
  ): void {
    const frame: AttentionTickFrame = {
      type: "attention.tick",
      id: "1789387200000",
      occurredAt: "2026-09-14T12:00:00.000Z",
      decisions: 1,
      updates: 0,
      changed,
      projectIds: ["project-1"],
      ...overrides,
    };

    this.dispatchEvent(
      new MessageEvent("attention.tick", {
        data: JSON.stringify(frame),
        lastEventId: frame.id,
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

const labels = {
  disconnected: "Disconnected",
  live: "Live",
  reconnect: "Reconnect",
  reconnecting: "Reconnecting",
};

function ActiveReview() {
  const invalidation = useWatchedReview({
    kind: "vault",
    id: "settled-proposal",
  });

  return createElement("output", null, invalidation);
}

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
  delete (document as { visibilityState?: DocumentVisibilityState })
    .visibilityState;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("app attention refresh", () => {
  it("rechecks a watched detail without refreshing the shell when the pending queue is unchanged", () => {
    act(() => root.unmount());
    AttentionEventSource.sources = [];
    root = createRoot(container);
    act(() =>
      root.render(
        createElement(
          AttentionReviewProvider,
          null,
          createElement(AttentionLiveRefresh, {
            labels,
            since: {
              cursor: "1789387100000",
              decisions: 1,
              updates: 0,
              reviews: 1,
              reviewVersion: "queue-v1",
            },
          }),
          createElement(ActiveReview),
        ),
      ),
    );
    const selected = AttentionEventSource.sources.at(-1)!;

    act(() => selected.onopen?.());
    act(() =>
      selected.tick(["reviews"], { reviews: 1, reviewVersion: "queue-v1" }),
    );
    expect(container.querySelector("output")?.textContent).toBe("2");
    expect(router.refresh).not.toHaveBeenCalled();
    act(() =>
      selected.tick(["reviews"], { reviews: 0, reviewVersion: "queue-v2" }),
    );
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("K13 revalidates the exact selected review on reconnect without a tick", () => {
    act(() => root.unmount());
    AttentionEventSource.sources = [];
    root = createRoot(container);
    act(() =>
      root.render(
        createElement(
          AttentionReviewProvider,
          null,
          createElement(AttentionLiveRefresh, { labels }),
          createElement(ActiveReview),
        ),
      ),
    );
    const selected = AttentionEventSource.sources.at(-1)!;

    expect(new URL(selected.url).searchParams.get("reviewId")).toBe(
      "settled-proposal",
    );
    act(() => selected.onopen?.());
    expect(container.querySelector("output")?.textContent).toBe("1");
    act(() => selected.onerror?.());
    act(() => vi.advanceTimersByTime(500));
    const reconnected = AttentionEventSource.sources.at(-1)!;

    expect(reconnected).not.toBe(selected);
    expect(new URL(reconnected.url).searchParams.get("reviewKind")).toBe(
      "vault",
    );
    act(() => reconnected.onopen?.());
    expect(container.querySelector("output")?.textContent).toBe("2");
    expect(router.refresh).not.toHaveBeenCalled();
  });

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

  it("opens zero EventSource connections while mounted hidden and connects with D7 cursor/counters on visible", () => {
    act(() => root.unmount());
    AttentionEventSource.sources = [];
    setVisibilityState("hidden");
    root = createRoot(container);

    act(() =>
      root.render(
        createElement(AttentionLiveRefresh, {
          labels,
          since: {
            cursor: "1789387100000",
            decisions: 2,
            updates: 5,
            reviews: 1,
            reviewVersion: "queue-v1",
          },
        }),
      ),
    );

    expect(AttentionEventSource.sources).toHaveLength(0);

    act(() => transitionVisibility("visible"));
    expect(AttentionEventSource.sources).toHaveLength(1);
    const params = new URL(AttentionEventSource.sources[0].url).searchParams;

    expect(params.get("lastEventId")).toBe("1789387100000");
    expect(params.get("decisions")).toBe("2");
    expect(params.get("updates")).toBe("5");
    expect(params.get("reviews")).toBe("1");
    expect(params.get("reviewVersion")).toBe("queue-v1");
  });

  it("EDGE-PERF-04 pauses on hidden without backoff, suppresses refresh while hidden, and resumes with last cursor, K13 reviewResync, and deferred refresh", () => {
    act(() => root.unmount());
    AttentionEventSource.sources = [];
    setVisibilityState("visible");
    root = createRoot(container);

    act(() =>
      root.render(
        createElement(
          AttentionReviewProvider,
          null,
          createElement(AttentionLiveRefresh, {
            labels,
            since: {
              cursor: "1789387100000",
              decisions: 2,
              updates: 5,
              reviews: 1,
              reviewVersion: "queue-v1",
            },
          }),
          createElement(ActiveReview),
        ),
      ),
    );

    const first = AttentionEventSource.sources.at(-1)!;
    const countAfterMount = AttentionEventSource.sources.length;

    act(() => first.onopen?.());
    expect(container.querySelector("output")?.textContent).toBe("1");
    expect(router.refresh).not.toHaveBeenCalled();

    // A frame buffered right as the tab turns hidden updates the cursor/counters
    // while router.refresh() is suppressed until the tab returns to visible.
    setVisibilityState("hidden");
    act(() =>
      first.tick(["decisions", "reviews"], {
        id: "1789387250000",
        decisions: 3,
        updates: 7,
        reviews: 2,
        reviewVersion: "queue-v2",
      }),
    );
    expect(router.refresh).not.toHaveBeenCalled();

    // Dispatching visibilitychange closes the active EventSource cleanly.
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(first.close).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(60_000));
    expect(AttentionEventSource.sources).toHaveLength(countAfterMount);

    // Returning to visible reconnects with the last cursor/counters, flushes the
    // deferred router.refresh(), and triggers K13 reviewResync on open.
    act(() => transitionVisibility("visible"));
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(AttentionEventSource.sources).toHaveLength(countAfterMount + 1);

    const resumed = AttentionEventSource.sources.at(-1)!;
    const resumedParams = new URL(resumed.url).searchParams;

    expect(resumedParams.get("lastEventId")).toBe("1789387250000");
    expect(resumedParams.get("decisions")).toBe("3");
    expect(resumedParams.get("updates")).toBe("7");
    expect(resumedParams.get("reviews")).toBe("2");
    expect(resumedParams.get("reviewVersion")).toBe("queue-v2");
    expect(resumedParams.get("reviewKind")).toBe("vault");
    expect(resumedParams.get("reviewId")).toBe("settled-proposal");

    const invalidationBeforeOpen = Number(
      container.querySelector("output")?.textContent,
    );

    act(() => resumed.onopen?.());
    expect(Number(container.querySelector("output")?.textContent)).toBe(
      invalidationBeforeOpen + 1,
    );

    // Pending reconnect timers are cancelled on hidden without incrementing backoff.
    act(() => resumed.onerror?.());
    act(() => vi.advanceTimersByTime(250));
    act(() => transitionVisibility("hidden"));
    act(() => vi.advanceTimersByTime(10_000));
    expect(AttentionEventSource.sources).toHaveLength(countAfterMount + 1);

    act(() => transitionVisibility("visible"));
    expect(AttentionEventSource.sources).toHaveLength(countAfterMount + 2);
    const third = AttentionEventSource.sources.at(-1)!;

    act(() => third.onerror?.());
    // Backoff starts fresh at 500ms rather than 1000ms.
    act(() => vi.advanceTimersByTime(499));
    expect(AttentionEventSource.sources).toHaveLength(countAfterMount + 2);
    act(() => vi.advanceTimersByTime(1));
    expect(AttentionEventSource.sources).toHaveLength(countAfterMount + 3);
  });

  it("PERF-07 shares one /api/attention/stream EventSource across AttentionLiveRefresh and TaskLaunchIntentStatus under AttentionStreamProvider", () => {
    act(() => root.unmount());
    AttentionEventSource.sources = [];
    setVisibilityState("visible");
    root = createRoot(container);

    const onRefresh = vi.fn(async () => {});

    act(() =>
      root.render(
        createElement(
          AttentionReviewProvider,
          null,
          createElement(
            AttentionStreamProvider,
            {
              since: {
                cursor: "1789387100000",
                decisions: 1,
                updates: 2,
              },
            },
            createElement(AttentionLiveRefresh, { labels }),
            createElement(TaskLaunchIntentStatus, {
              receipt: null,
              busy: false,
              uncertain: false,
              errorReason: null,
              onRefresh,
              onRetryRequest: async () => {},
              onCancel: async () => {},
              onReplace: () => {},
              onNewLaunch: () => {},
            }),
          ),
        ),
      ),
    );

    expect(AttentionEventSource.sources).toHaveLength(1);
    const shared = AttentionEventSource.sources[0];

    expect(new URL(shared.url).pathname).toBe("/api/attention/stream");
    act(() => shared.onopen?.());
    act(() => shared.tick(["work"]));
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalled();
  });
});
