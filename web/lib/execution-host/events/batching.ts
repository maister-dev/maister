import "server-only";

// ADR-167 amendment 2026-09-25: the consumer reads a host stream continuously
// into a bounded buffer and commits it in batches. This module owns the two
// pieces with no I/O — where a batch is cut, and the buffer that couples a
// reader to a batcher — so both are unit-testable without a database or host.

export type IngestBatchLimits = Readonly<{
  /** `N`: rows per batch. */
  rows: number;
  /** `B`: payload bytes per batch; one larger envelope still forms a batch. */
  bytes: number;
  /** `T`: how long a batch waits after its first row was buffered. */
  waitMs: number;
  /** Rows the reader may buffer before it stops reading the socket. */
  bufferRows: number;
  /** Payload bytes the reader may buffer before it stops reading. */
  bufferBytes: number;
}>;

export const INGEST_BATCH_BYTES = 4 * 1_048_576;
// Chosen by the R20 sweep (2026-09-26): at N = 200 the smallest wait whose
// host-to-manager lag stayed at or below N (T = 100: max 60 rows; 250: 122;
// 500: 214 > N).
export const INGEST_BATCH_WAIT_MS = 100;
export const INGEST_BUFFER_BYTES = 16 * 1_048_576;

export function ingestBatchLimits(rows: number): IngestBatchLimits {
  return Object.freeze({
    rows,
    bytes: INGEST_BATCH_BYTES,
    waitMs: INGEST_BATCH_WAIT_MS,
    bufferRows: 4 * rows,
    bufferBytes: INGEST_BUFFER_BYTES,
  });
}

export type BufferedFrame = Readonly<{ streamId: string; bytes: number }>;

/** How many leading frames the next batch takes, or 0 to keep waiting. A
 * batch never spans two streams, never exceeds `remaining` (the pass's
 * `maxEvents` budget), and is cut at the first of N rows, B bytes, T elapsed
 * since its first row, a stream change, or the end of the stream. */
export function cutBatch(
  buffer: readonly BufferedFrame[],
  input: Readonly<{
    limits: IngestBatchLimits;
    remaining: number;
    elapsedMs: number;
    ended: boolean;
  }>,
): number {
  const first = buffer[0];

  if (!first || input.remaining <= 0) return 0;
  const cap = Math.min(input.limits.rows, input.remaining);
  let take = 0;
  let bytes = 0;
  let full = false;

  for (const frame of buffer) {
    if (frame.streamId !== first.streamId) {
      full = true;
      break;
    }
    if (take > 0 && bytes + frame.bytes > input.limits.bytes) {
      full = true;
      break;
    }
    take += 1;
    bytes += frame.bytes;
    if (take >= cap || bytes >= input.limits.bytes) {
      full = true;
      break;
    }
  }

  return full || input.ended || input.elapsedMs >= input.limits.waitMs
    ? take
    : 0;
}

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

/** The reader/batcher coupling. The reader `push`es each frame and, when the
 * buffer is at a bound, awaits `space()` — so the socket is not read and the
 * host pauses the subscriber. The batcher takes batches with `next()`. `close`
 * is the batcher's exit on every path: it releases a waiting reader and
 * discards what is buffered. */
export class IngestBuffer<T extends BufferedFrame> {
  private readonly frames: T[] = [];
  /** When each buffered frame arrived: T counts from a batch's FIRST row. */
  private readonly arrivals: number[] = [];
  private bytes = 0;
  private ended = false;
  private closed = false;
  private changed = deferred();
  private drained = deferred();

  constructor(
    private readonly limits: IngestBatchLimits,
    private readonly clock: () => number = Date.now,
  ) {}

  get size(): number {
    return this.frames.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private full(): boolean {
    return (
      this.frames.length >= this.limits.bufferRows ||
      this.bytes >= this.limits.bufferBytes
    );
  }

  private notify(): void {
    const changed = this.changed;

    this.changed = deferred();
    changed.resolve();
  }

  push(frame: T): void {
    if (this.closed || this.ended) return;
    this.frames.push(frame);
    this.arrivals.push(this.clock());
    this.bytes += frame.bytes;
    this.notify();
  }

  /** Resolves once the buffer is below both bounds, or closed. */
  async space(): Promise<void> {
    while (!this.closed && this.full()) await this.drained.promise;
  }

  /** The stream ended; what is buffered still forms batches. */
  end(): void {
    this.ended = true;
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.frames.length = 0;
    this.arrivals.length = 0;
    this.bytes = 0;
    this.drained.resolve();
    this.notify();
  }

  /** The next batch, or null once the stream ended and the buffer is empty
   * (or the buffer was closed). */
  async next(remaining: number): Promise<T[] | null> {
    for (;;) {
      if (this.closed) return null;
      const firstArrival = this.arrivals[0];
      const elapsedMs =
        firstArrival === undefined ? 0 : this.clock() - firstArrival;
      const take = cutBatch(this.frames, {
        limits: this.limits,
        remaining,
        elapsedMs,
        ended: this.ended,
      });

      if (take > 0) {
        const batch = this.frames.splice(0, take);

        this.arrivals.splice(0, take);
        for (const frame of batch) this.bytes -= frame.bytes;
        const drained = this.drained;

        this.drained = deferred();
        drained.resolve();

        return batch;
      }
      if (this.ended && this.frames.length === 0) return null;
      const changed = this.changed.promise;
      const waitMs =
        firstArrival === undefined ? null : this.limits.waitMs - elapsedMs;
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          changed,
          ...(waitMs === null
            ? []
            : [
                new Promise<void>((resolve) => {
                  // Unref'd: an idle pass must never keep a process alive.
                  timer = setTimeout(resolve, Math.max(0, waitMs));
                  timer.unref?.();
                }),
              ]),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }
}
