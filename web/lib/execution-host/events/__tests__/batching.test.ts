import { describe, expect, it } from "vitest";

import {
  cutBatch,
  IngestBuffer,
  ingestBatchLimits,
  type BufferedFrame,
  type IngestBatchLimits,
} from "@/lib/execution-host/events/batching";

const limits: IngestBatchLimits = {
  rows: 3,
  bytes: 100,
  waitMs: 250,
  bufferRows: 6,
  bufferBytes: 1_000,
};

function frames(...bytes: number[]): BufferedFrame[] {
  return bytes.map((size) => ({ streamId: "s", bytes: size }));
}

describe("cutBatch", () => {
  const cut = (
    buffer: readonly BufferedFrame[],
    overrides: Partial<Parameters<typeof cutBatch>[1]> = {},
  ) =>
    cutBatch(buffer, {
      limits,
      remaining: Number.POSITIVE_INFINITY,
      elapsedMs: 0,
      ended: false,
      ...overrides,
    });

  it("waits for more rows until N, B or T", () => {
    expect(cut([])).toBe(0);
    expect(cut(frames(10, 10))).toBe(0);
    expect(cut(frames(10, 10), { elapsedMs: 250 })).toBe(2);
    expect(cut(frames(10, 10, 10, 10))).toBe(3);
    expect(cut(frames(60, 30, 20))).toBe(2);
    expect(cut(frames(100))).toBe(1);
  });

  it("keeps one envelope above B as a batch of one", () => {
    expect(cut(frames(500, 10))).toBe(1);
  });

  it("cuts before a stream change and never spans two streams", () => {
    const buffer = [
      { streamId: "a", bytes: 1 },
      { streamId: "b", bytes: 1 },
    ];

    expect(cut(buffer)).toBe(1);
  });

  it("honours the pass budget exactly", () => {
    expect(cut(frames(1, 1, 1), { remaining: 2 })).toBe(2);
    expect(cut(frames(1), { remaining: 0, ended: true })).toBe(0);
  });

  it("commits what is buffered once the stream ended", () => {
    expect(cut(frames(1), { ended: true })).toBe(1);
  });

  it("derives the reader bounds from N", () => {
    expect(ingestBatchLimits(200)).toMatchObject({
      rows: 200,
      bufferRows: 800,
      waitMs: 250,
    });
  });
});

describe("IngestBuffer", () => {
  it("cuts a trickle at T measured from the batch's first row", async () => {
    let clock = 0;
    const buffer = new IngestBuffer(limits, () => clock);

    buffer.push({ streamId: "s", bytes: 1 });
    clock = 200;
    buffer.push({ streamId: "s", bytes: 1 });
    clock = 250;

    expect(await buffer.next(Number.POSITIVE_INFINITY)).toHaveLength(2);
  });

  it("releases a reader waiting for space when a batch is taken", async () => {
    const buffer = new IngestBuffer(limits);

    for (let index = 0; index < limits.bufferRows; index += 1)
      buffer.push({ streamId: "s", bytes: 1 });
    let released = false;
    const waiting = buffer.space().then(() => {
      released = true;
    });

    await Promise.resolve();
    expect(released).toBe(false);
    expect(await buffer.next(Number.POSITIVE_INFINITY)).toHaveLength(3);
    await waiting;
    expect(released).toBe(true);
  });

  it("never leaves a reader waiting on a batcher that is gone", async () => {
    const buffer = new IngestBuffer(limits);

    for (let index = 0; index < limits.bufferRows; index += 1)
      buffer.push({ streamId: "s", bytes: 1 });
    const waiting = buffer.space();

    buffer.close();
    await expect(waiting).resolves.toBeUndefined();
    expect(buffer.size).toBe(0);
    expect(await buffer.next(Number.POSITIVE_INFINITY)).toBeNull();
    // A late frame after the exit is discarded, not buffered.
    buffer.push({ streamId: "s", bytes: 1 });
    expect(buffer.size).toBe(0);
  });

  it("drains after the stream ended, then reports the end", async () => {
    const buffer = new IngestBuffer(limits);

    for (let index = 0; index < 4; index += 1)
      buffer.push({ streamId: "s", bytes: 1 });
    buffer.end();

    expect(await buffer.next(Number.POSITIVE_INFINITY)).toHaveLength(3);
    expect(await buffer.next(Number.POSITIVE_INFINITY)).toHaveLength(1);
    expect(await buffer.next(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("wakes a waiting batcher on the first row, then on T", async () => {
    const buffer = new IngestBuffer({ ...limits, waitMs: 20 });
    const next = buffer.next(Number.POSITIVE_INFINITY);

    buffer.push({ streamId: "s", bytes: 1 });

    expect(await next).toHaveLength(1);
  });
});
