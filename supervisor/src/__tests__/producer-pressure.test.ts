import type { HostState } from "../host-state";
import type { SessionRecord } from "../types";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { producerPressure } from "../producer-pressure";

// A capacity-less host: frames are refused until `capacity` flips, and every
// capacity listener is woken by `notify`.
function fakeHost(opts: { outboxRefuses: () => boolean }) {
  let capacity = false;
  const listeners = new Set<() => void>();
  const state = {
    tryReserveRuntimeFrame: () => (capacity ? "reservation-1" : null),
    releaseRuntimeFrame: () => {},
    subscribeRuntimeCapacity: (listener: () => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    runtimeEventOutboxRefusesFrames: opts.outboxRefuses,
    runtimeEventOutboxStats: () => ({ budget: { pressured: true } }),
  } as unknown as HostState;

  return {
    state,
    listeners,
    grant() {
      capacity = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

function record(): SessionRecord {
  return { createdByCommandId: "create-1" } as SessionRecord;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("producer pause bound (ADR-183 D6)", () => {
  it("fires once, after the bound, while the outbox still refuses frames", async () => {
    const host = fakeHost({ outboxRefuses: () => true });
    const rec = record();
    const onExceeded = vi.fn();
    const pressure = producerPressure(host.state, rec, undefined, {
      maxMs: 1_000,
      onExceeded,
    });

    void pressure.beforeFrame(1024);
    expect(rec.outputPaused).toBe(true);
    expect(rec.outputPausedSince).toEqual(expect.any(Number));
    vi.advanceTimersByTime(999);
    expect(onExceeded).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExceeded).toHaveBeenCalledTimes(1);
    expect(onExceeded).toHaveBeenCalledWith(expect.any(Number));
    vi.advanceTimersByTime(10_000);
    expect(onExceeded).toHaveBeenCalledTimes(1);
  });

  it("clears the timer and the pause stamp when capacity returns first", async () => {
    const host = fakeHost({ outboxRefuses: () => true });
    const rec = record();
    const onExceeded = vi.fn();
    const pressure = producerPressure(host.state, rec, undefined, {
      maxMs: 1_000,
      onExceeded,
    });
    const admitted = pressure.beforeFrame(1024);

    vi.advanceTimersByTime(500);
    host.grant();
    await expect(admitted).resolves.toMatchObject({ kind: "decode" });
    expect(rec.outputPaused).toBe(false);
    expect(rec.outputPausedSince).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it("never parks a producer that is already stopping", async () => {
    const host = fakeHost({ outboxRefuses: () => true });
    const rec = record();
    const onExceeded = vi.fn();
    const pressure = producerPressure(host.state, rec, undefined, {
      maxMs: 1_000,
      onExceeded,
    });
    const admitted = pressure.beforeFrame(1024);

    pressure.beginTeardown();
    await expect(admitted).resolves.toMatchObject({ kind: "drain" });
    vi.advanceTimersByTime(10_000);
    expect(onExceeded).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-arms instead of parking when the outbox is not what refuses the frame", async () => {
    let outboxRefuses = false;
    const host = fakeHost({ outboxRefuses: () => outboxRefuses });
    const rec = record();
    const onExceeded = vi.fn();
    const pressure = producerPressure(host.state, rec, undefined, {
      maxMs: 1_000,
      onExceeded,
    });

    void pressure.beforeFrame(1024);
    vi.advanceTimersByTime(3_000);
    expect(onExceeded).not.toHaveBeenCalled();
    outboxRefuses = true;
    vi.advanceTimersByTime(1_000);
    expect(onExceeded).toHaveBeenCalledTimes(1);
  });

  it("does not bound a log-write wait (runtime-file capacity)", async () => {
    const host = fakeHost({ outboxRefuses: () => true });
    const rec = record();
    const onExceeded = vi.fn();
    const files = {
      tryReserveLogBytes: () => false,
      reserveTeardownLogBytes: () => {},
    };
    const pressure = producerPressure(host.state, rec, files as never, {
      maxMs: 1_000,
      onExceeded,
    });

    void pressure.beforeWrite(1024);
    vi.advanceTimersByTime(10_000);
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it("uses an unreferenced timer", async () => {
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms?: number,
    ) => {
      const handle = realSetTimeout(handler, ms);

      (handle as unknown as { unref: () => void }).unref = unref;

      return handle;
    }) as typeof setTimeout);
    const host = fakeHost({ outboxRefuses: () => true });
    const pressure = producerPressure(host.state, record(), undefined, {
      maxMs: 1_000,
      onExceeded: () => {},
    });

    void pressure.beforeFrame(1024);
    expect(unref).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
