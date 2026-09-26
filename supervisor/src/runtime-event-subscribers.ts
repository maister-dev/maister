import type { Writable } from "node:stream";
import type { Logger } from "pino";
import type { HostRuntimeEventRow } from "./host-state";
import type { RuntimeEventCloseReason } from "./types";

import { once } from "node:events";

import { HostRuntimeEventError } from "./host-runtime-errors";

// ADR-167 amendment 2026-09-25: a `GET /runtime-events` subscriber is served
// by a pump over the durable outbox. It pages retained rows after its cursor
// until an empty page, then goes live; a `write()` that returns false pauses it
// until `drain`. The host no longer closes a slow or far-behind subscriber —
// the outbox is the buffer, so per-subscriber memory is one page plus Node's
// write buffer, and the publisher never waits on, or queues for, a subscriber.

export type { RuntimeEventCloseReason };

export type RuntimeEventSubscriberCounters = {
  /** Times a subscriber was paused because its socket stopped draining. */
  subscriberPauses: number;
  closes: Record<RuntimeEventCloseReason, number>;
};

/** The response a subscriber writes to (an `http.ServerResponse`). */
export type RuntimeEventSink = Writable;

export type RuntimeEventSource = {
  /** One bounded page (≤ 500 rows, ≤ 1 MiB) strictly after the cursor. */
  page(cursor: string | null): HostRuntimeEventRow[];
  subscribe(listener: (event: HostRuntimeEventRow) => void): () => void;
};

type Mode = "catchup" | "live" | "paused";

function frame(event: HostRuntimeEventRow): string {
  return `id: ${event.sequence}\nevent: ${String(event.envelope.eventType)}\ndata: ${JSON.stringify(event.envelope)}\n\n`;
}

// Every page-read failure maps to exactly one reason; anything that is not a
// lost floor means the host cannot continue this stream under its contract.
function readFailureReason(error: unknown): RuntimeEventCloseReason {
  return error instanceof HostRuntimeEventError &&
    error.reason === "replay_floor_exceeded"
    ? "floor"
    : "protocol";
}

export class RuntimeEventSubscriber {
  private cursor: string | null;
  private mode: Mode = "catchup";
  private closed = false;
  private pumping = false;
  private pauses = 0;
  private readonly drainAbort = new AbortController();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly owner: RuntimeEventSubscribers,
    private readonly input: {
      streamId: string;
      afterSequence: string | null;
      source: RuntimeEventSource;
      sink: RuntimeEventSink;
      logger: Logger;
    },
  ) {
    this.cursor = input.afterSequence;
    // Registered before the first page is written: an append committed while
    // the pump catches up is in SQLite, and the pump pages it.
    this.unsubscribe = input.source.subscribe((event) => this.onLive(event));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get bufferedBytes(): number {
    return this.input.sink.writableLength;
  }

  /** The first page was read before the headers; serve it, then keep going. */
  start(firstPage: HostRuntimeEventRow[]): void {
    void this.pump(firstPage);
  }

  close(reason: RuntimeEventCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    // Settles a pending `drain` wait and removes its listener: a paused
    // subscriber's continuation must not outlive its connection.
    this.drainAbort.abort();
    this.owner.recordClose(this, reason);
    this.input.logger.info(
      {
        streamId: this.input.streamId,
        afterSequence: this.input.afterSequence,
        cursor: this.cursor,
        reason,
        pauses: this.pauses,
      },
      "runtime-event-stream-closed",
    );
    if (!this.input.sink.writableEnded && !this.input.sink.destroyed)
      this.input.sink.end();
  }

  // Returns false when the socket buffer is past its high-water mark. The
  // frame WAS buffered, so the cursor already covers it.
  private write(event: HostRuntimeEventRow): boolean {
    const written = this.input.sink.write(frame(event));

    this.cursor = event.sequence;

    return written;
  }

  private async waitForDrain(): Promise<boolean> {
    this.mode = "paused";
    this.pauses += 1;
    this.owner.recordPause();
    this.input.logger.debug(
      {
        streamId: this.input.streamId,
        cursor: this.cursor,
        pauses: this.pauses,
      },
      "runtime-event-stream-paused",
    );
    try {
      await once(this.input.sink, "drain", { signal: this.drainAbort.signal });
    } catch {
      // Aborted by close(), or the response errored: either way the
      // connection is gone.
      this.close("disconnect");

      return false;
    }
    if (this.closed) return false;
    this.mode = "catchup";
    this.input.logger.debug(
      {
        streamId: this.input.streamId,
        cursor: this.cursor,
        pauses: this.pauses,
      },
      "runtime-event-stream-resumed",
    );

    return true;
  }

  private async pump(firstPage?: HostRuntimeEventRow[]): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    this.mode = "catchup";
    let page = firstPage;

    try {
      for (;;) {
        if (this.closed) return;
        if (page === undefined) {
          try {
            page = this.input.source.page(this.cursor);
          } catch (error) {
            this.input.logger.warn(
              {
                streamId: this.input.streamId,
                cursor: this.cursor,
                reason:
                  error instanceof HostRuntimeEventError
                    ? error.reason
                    : "page_read_failed",
              },
              "runtime-event-stream-read-failed",
            );
            this.close(readFailureReason(error));

            return;
          }
        }
        // Synchronous with the read above: every notified event is committed
        // before notification, so an empty page is the head and nothing can
        // land between this check and going live.
        if (page.length === 0) {
          this.mode = "live";

          return;
        }
        let paused = false;

        for (const event of page) {
          if (this.closed) return;
          if (
            this.cursor !== null &&
            BigInt(event.sequence) <= BigInt(this.cursor)
          )
            continue;
          if (!this.write(event)) {
            paused = true;
            break;
          }
        }
        page = undefined;
        if (paused && !(await this.waitForDrain())) return;
      }
    } finally {
      this.pumping = false;
    }
  }

  private onLive(event: HostRuntimeEventRow): void {
    if (this.closed || this.mode !== "live") return;
    if (event.streamId !== this.input.streamId) {
      // The publisher moved to another stream under this subscriber; the
      // manager's reconnect meets the open-time identity refusal.
      this.close("protocol");

      return;
    }
    if (
      this.cursor === null ||
      BigInt(event.sequence) !== BigInt(this.cursor) + 1n
    ) {
      if (this.cursor !== null && BigInt(event.sequence) <= BigInt(this.cursor))
        return;
      // SQLite has the rows: page them instead of guessing.
      void this.pump();

      return;
    }
    if (!this.write(event)) {
      void this.waitForDrain().then((resumed) => {
        if (resumed) void this.pump();
      });
    }
  }
}

/** The per-boot subscriber registry: the live set for the shutdown hook and
 * the counters `/health?includeStream=true` reports. */
export class RuntimeEventSubscribers {
  private readonly live = new Set<RuntimeEventSubscriber>();
  private subscriberPauses = 0;
  private readonly closes = {
    disconnect: 0,
    protocol: 0,
    floor: 0,
    shutdown: 0,
  } satisfies Record<RuntimeEventCloseReason, number>;

  constructor(private readonly logger: Logger) {}

  open(input: {
    streamId: string;
    afterSequence: string | null;
    firstPage: HostRuntimeEventRow[];
    source: RuntimeEventSource;
    sink: RuntimeEventSink;
  }): RuntimeEventSubscriber {
    const subscriber = new RuntimeEventSubscriber(this, {
      streamId: input.streamId,
      afterSequence: input.afterSequence,
      source: input.source,
      sink: input.sink,
      logger: this.logger,
    });

    this.live.add(subscriber);
    input.sink.once("error", () => subscriber.close("disconnect"));
    subscriber.start(input.firstPage);

    return subscriber;
  }

  recordPause(): void {
    this.subscriberPauses += 1;
  }

  recordClose(
    subscriber: RuntimeEventSubscriber,
    reason: RuntimeEventCloseReason,
  ): void {
    this.live.delete(subscriber);
    this.closes[reason] += 1;
  }

  /** Ends every open subscriber — before the server waits on its sockets. */
  closeAll(reason: RuntimeEventCloseReason): void {
    for (const subscriber of [...this.live]) subscriber.close(reason);
  }

  get openCount(): number {
    return this.live.size;
  }

  /** Bytes open subscribers hold in their socket write buffers — with the
   * page being written, all the memory a subscriber retains. */
  bufferedBytes(): number {
    let bytes = 0;

    for (const subscriber of this.live) bytes += subscriber.bufferedBytes;

    return bytes;
  }

  counters(): RuntimeEventSubscriberCounters {
    return {
      subscriberPauses: this.subscriberPauses,
      closes: { ...this.closes },
    };
  }
}
