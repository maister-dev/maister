import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCoalescedRefresher } from "@/lib/runs/coalesced-refresh";

describe("createCoalescedRefresher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes steadily under continuous 20 Hz bursts instead of starving", async () => {
    const run = vi.fn(async (_signal: AbortSignal) => {});
    const refresher = createCoalescedRefresher({ intervalMs: 250, run });

    for (let tick = 0; tick < 20; tick += 1) {
      refresher.trigger();
      await vi.advanceTimersByTimeAsync(50);
    }

    expect(run).toHaveBeenCalledTimes(4);

    refresher.dispose();
  });

  it("keeps an in-flight signal un-aborted on new ticks and coalesces them into one follow-up run", async () => {
    let resolveFirst!: () => void;
    const signals: AbortSignal[] = [];
    const run = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      if (signals.length === 1) {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }

      return Promise.resolve();
    });
    const refresher = createCoalescedRefresher({ intervalMs: 250, run });

    refresher.trigger();
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);

    // Burst of triggers while run #1 is still in flight.
    for (let tick = 0; tick < 5; tick += 1) {
      refresher.trigger();
      await vi.advanceTimersByTimeAsync(50);
    }

    expect(signals[0]?.aborted).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();

    // Respects intervalMs before starting the single coalesced follow-up run.
    await vi.advanceTimersByTimeAsync(249);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);

    // No extra follow-up runs after the coalesced one settles.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);

    refresher.dispose();
  });

  it("dispose clears pending timers, aborts in-flight signals, and ignores later triggers", async () => {
    const pendingRun = vi.fn(async (_signal: AbortSignal) => {});
    const pendingRefresher = createCoalescedRefresher({
      intervalMs: 250,
      run: pendingRun,
    });

    pendingRefresher.trigger();
    pendingRefresher.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pendingRun).not.toHaveBeenCalled();

    let resolveInFlight!: () => void;
    let capturedSignal: AbortSignal | null = null;
    const inFlightRun = vi.fn((signal: AbortSignal) => {
      capturedSignal = signal;

      return new Promise<void>((resolve) => {
        resolveInFlight = resolve;
      });
    });
    const inFlightRefresher = createCoalescedRefresher({
      intervalMs: 250,
      run: inFlightRun,
    });

    inFlightRefresher.trigger();
    await vi.advanceTimersByTimeAsync(250);
    expect(inFlightRun).toHaveBeenCalledTimes(1);
    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);

    // Queue a follow-up, then dispose while run #1 is in flight.
    inFlightRefresher.trigger();
    inFlightRefresher.dispose();
    expect(capturedSignal!.aborted).toBe(true);

    resolveInFlight();
    await Promise.resolve();
    await Promise.resolve();

    inFlightRefresher.trigger();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inFlightRun).toHaveBeenCalledTimes(1);
  });

  it("swallows rejecting async callbacks without unhandled rejection and keeps the scheduler alive", async () => {
    const onUnhandled = vi.fn();

    process.on("unhandledRejection", onUnhandled);
    try {
      let attempt = 0;
      const run = vi.fn(async (_signal: AbortSignal) => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient refresh failure");
      });
      const refresher = createCoalescedRefresher({ intervalMs: 250, run });

      refresher.trigger();
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(1);

      refresher.trigger();
      await vi.advanceTimersByTimeAsync(250);
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(2);
      expect(onUnhandled).not.toHaveBeenCalled();

      refresher.dispose();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("schedules a single follow-up run when trigger() is called synchronously inside run", async () => {
    let calls = 0;
    const refresher = createCoalescedRefresher({
      intervalMs: 250,
      run: () => {
        calls += 1;
        if (calls === 1) {
          refresher.trigger();
          refresher.trigger();
        }
      },
    });

    refresher.trigger();
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);

    refresher.dispose();
  });
});
