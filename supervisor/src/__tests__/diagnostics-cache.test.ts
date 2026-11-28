// DIAG-01…DIAG-09 (ADR-224, docs/system-analytics/host-diagnostics.md) — the
// pure snapshot policy behind supervisor `GET /diagnostics`. A fake clock, a
// controllable `compute` and a mutable source version drive every rule; the
// route wiring is proven separately in diagnostics-route.integration.test.ts.
import { describe, expect, it, vi } from "vitest";

import { createDiagnosticsCache } from "../diagnostics-cache";

type Value = { id: string };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

const TTL = 30_000;
const SWR = 300_000;

function harness() {
  let clock = 0;
  let version: number | null = 1;
  const pending: Deferred<Value>[] = [];
  const compute = vi.fn((_startedAt: number) => {
    const d = deferred<Value>();

    pending.push(d);

    return d.promise;
  });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const sourceVersion = vi.fn(async () => version);
  const cache = createDiagnosticsCache<Value>({
    ttlMs: TTL,
    staleWhileRevalidateMs: SWR,
    now: () => clock,
    compute,
    sourceVersion,
    logger,
  });

  return {
    cache,
    compute,
    logger,
    sourceVersion,
    pending,
    setClock: (t: number) => {
      clock = t;
    },
    setVersion: (v: number | null) => {
      version = v;
    },
    /** Resolve the n-th compute (0-based) once it has started. */
    async settle(n: number, value: Value) {
      await vi.waitFor(() => expect(pending[n]).toBeDefined());
      pending[n]!.resolve(value);
    },
  };
}

/** Lets queued microtasks (version reads, joins) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("diagnostics snapshot policy", () => {
  it("DIAG-01 a request within the TTL returns the stored snapshot without computing", async () => {
    const h = harness();
    const first = h.cache.get();

    await h.settle(0, { id: "v1" });
    const v1 = await first;

    h.setClock(TTL - 1);
    const second = await h.cache.get();

    expect(second).toBe(v1);
    expect(h.compute).toHaveBeenCalledTimes(1);
  });

  it("DIAG-02 concurrent non-forced requests share one in-flight compute", async () => {
    const h = harness();
    const calls = Array.from({ length: 20 }, () => h.cache.get());

    await h.settle(0, { id: "v1" });
    const values = await Promise.all(calls);

    expect(h.compute).toHaveBeenCalledTimes(1);
    expect(new Set(values).size).toBe(1);
  });

  it("DIAG-03 a stale-servable snapshot returns at once and starts exactly one background compute", async () => {
    const h = harness();
    const first = h.cache.get();

    await h.settle(0, { id: "v1" });
    const v1 = await first;

    h.setClock(TTL + 15_000);
    const stale = await Promise.all(
      Array.from({ length: 5 }, () => h.cache.get()),
    );

    // Every stale read resolved while the background compute is still pending.
    expect(stale.every((value) => value === v1)).toBe(true);
    expect(h.compute).toHaveBeenCalledTimes(2);

    await h.settle(1, { id: "v2" });
    await flush();
    expect(await h.cache.get()).toEqual({ id: "v2" });
    expect(h.compute).toHaveBeenCalledTimes(2);
  });

  it("DIAG-04 a snapshot past the stale window makes the request await a new compute", async () => {
    const h = harness();
    const first = h.cache.get();

    await h.settle(0, { id: "v1" });
    await first;

    h.setClock(SWR + 1);
    let settled = false;
    const late = h.cache.get().then((value) => {
      settled = true;

      return value;
    });

    await flush();
    expect(settled).toBe(false);

    await h.settle(1, { id: "v2" });
    expect(await late).toEqual({ id: "v2" });
  });

  it("DIAG-04 edge: a clock regression is treated as an expired snapshot", async () => {
    const h = harness();

    h.setClock(10_000);
    const first = h.cache.get();

    await h.settle(0, { id: "v1" });
    await first;

    h.setClock(5_000);
    const afterRegression = h.cache.get();

    await h.settle(1, { id: "v2" });
    expect(await afterRegression).toEqual({ id: "v2" });
  });

  it("DIAG-05 a forced request never returns a compute that started before it arrived", async () => {
    const h = harness();
    const older = h.cache.get();

    await vi.waitFor(() => expect(h.compute).toHaveBeenCalledTimes(1));
    const forced = h.cache.get({ force: true });

    await h.settle(1, { id: "fresh" });
    expect(await forced).toEqual({ id: "fresh" });

    await h.settle(0, { id: "older" });
    expect(await older).toEqual({ id: "older" });
    expect(h.compute).toHaveBeenCalledTimes(2);
  });

  it("DIAG-05 a forced request joins a compute that started after it arrived", async () => {
    const h = harness();
    const forcedVersion = deferred<number | null>();

    h.sourceVersion.mockImplementationOnce(() => forcedVersion.promise);
    const forced = h.cache.get({ force: true });
    const plain = h.cache.get();

    await vi.waitFor(() => expect(h.compute).toHaveBeenCalledTimes(1));
    forcedVersion.resolve(1);
    await h.settle(0, { id: "shared" });

    expect(await forced).toEqual({ id: "shared" });
    expect(await plain).toEqual({ id: "shared" });
    expect(h.compute).toHaveBeenCalledTimes(1);
  });

  it("DIAG-06 an older generation finishing last never replaces a newer snapshot", async () => {
    const h = harness();
    const older = h.cache.get();

    await vi.waitFor(() => expect(h.compute).toHaveBeenCalledTimes(1));
    const newer = h.cache.get({ force: true });

    await h.settle(1, { id: "gen2" });
    await newer;
    await h.settle(0, { id: "gen1" });
    await older;

    expect(await h.cache.get()).toEqual({ id: "gen2" });
    expect(h.compute).toHaveBeenCalledTimes(2);
    // A forced refresh racing an older compute is routine, not an operator signal.
    expect(h.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 1, storedGeneration: 2 }),
      expect.any(String),
    );
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("DIAG-07 a changed source version is treated as no snapshot", async () => {
    const h = harness();
    const first = h.cache.get();

    await h.settle(0, { id: "v1" });
    await first;

    h.setClock(1_000);
    h.setVersion(2);
    const afterRewrite = h.cache.get();

    await h.settle(1, { id: "v2" });
    expect(await afterRewrite).toEqual({ id: "v2" });

    h.setVersion(null);
    const afterDelete = h.cache.get();

    await h.settle(2, { id: "v3" });
    expect(await afterDelete).toEqual({ id: "v3" });
    expect(h.compute).toHaveBeenCalledTimes(3);
  });

  it("DIAG-08 a failed compute rejects every joined request, is not stored, and the next request recomputes", async () => {
    const h = harness();
    const calls = Array.from({ length: 3 }, () => h.cache.get());
    const failure = new Error("probe failed");

    await vi.waitFor(() => expect(h.pending[0]).toBeDefined());
    h.pending[0]!.reject(failure);

    const results = await Promise.allSettled(calls);

    expect(results).toEqual(
      Array.from({ length: 3 }, () => ({
        status: "rejected",
        reason: failure,
      })),
    );

    const retry = h.cache.get();

    await h.settle(1, { id: "v1" });
    expect(await retry).toEqual({ id: "v1" });
    expect(h.compute).toHaveBeenCalledTimes(2);
  });

  it("DIAG-08 a background failure is logged at WARN and never surfaces to the stale reader", async () => {
    const h = harness();
    const first = h.cache.get();

    await h.settle(0, { id: "v1" });
    const v1 = await first;

    h.setClock(TTL + 1);
    expect(await h.cache.get()).toBe(v1);

    await vi.waitFor(() => expect(h.pending[1]).toBeDefined());
    h.pending[1]!.reject(new Error("background probe failed"));
    await flush();

    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 2 }),
      expect.stringContaining("background"),
    );
    // Still stale-servable: the failure stored nothing and a new background
    // compute starts on the next read.
    expect(await h.cache.get()).toBe(v1);
    expect(h.compute).toHaveBeenCalledTimes(3);
  });

  it("DIAG-09 snapshot age is measured from the probe start, not its completion", async () => {
    const h = harness();

    h.setClock(1_000);
    const first = h.cache.get();

    await vi.waitFor(() => expect(h.compute).toHaveBeenCalledTimes(1));
    expect(h.compute).toHaveBeenLastCalledWith(1_000);

    h.setClock(3_000);
    await h.settle(0, { id: "v1" });
    await first;

    // 30.5 s after the start but only 28.5 s after completion: already stale.
    h.setClock(1_000 + TTL + 500);
    await h.cache.get();
    expect(h.compute).toHaveBeenCalledTimes(2);
  });
});
