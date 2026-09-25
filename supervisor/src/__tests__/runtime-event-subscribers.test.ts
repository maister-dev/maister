// ADR-167 amendment 2026-09-25: the subscriber pump's state transitions,
// against a writable whose consumer the test controls. The integration suite
// (runtime-event-backpressure) asserts only end-to-end observables.
import type { HostRuntimeEventRow } from "../host-state";

import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { HostRuntimeEventError } from "../host-runtime-errors";
import {
  RuntimeEventSubscribers,
  type RuntimeEventSource,
} from "../runtime-event-subscribers";

const STREAM = "8f1c2d70-1f4a-4b60-9a2e-6c0d3b7e5a11";

/** A socket the test drains by hand: `write()` returns false once anything is
 * buffered (high-water mark 1), and frames reach `delivered` only on flush. */
class HeldSink extends Writable {
  readonly delivered: string[] = [];
  private held: Array<() => void> = [];
  flowing = false;

  constructor() {
    super({ highWaterMark: 1, decodeStrings: false });
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.delivered.push(String(chunk));
    if (this.flowing) callback();
    else this.held.push(() => callback());
  }

  async flush(): Promise<void> {
    this.flowing = true;
    while (this.held.length > 0) {
      this.held.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  sequences(): string[] {
    return this.delivered.map((text) => /^id: (\d+)/.exec(text)![1]!);
  }
}

class Outbox implements RuntimeEventSource {
  readonly rows: HostRuntimeEventRow[] = [];
  private readonly listeners = new Set<(row: HostRuntimeEventRow) => void>();
  failNext: Error | null = null;

  constructor(private readonly pageSize = 3) {}

  row(sequence: number, streamId = STREAM): HostRuntimeEventRow {
    return {
      streamId,
      sequence: String(sequence),
      eventId: `e-${sequence}`,
      envelope: { eventType: "session.update", sequence: String(sequence) },
      encodedBytes: 10,
      occurredAt: "2026-09-25T00:00:00.000Z",
      acknowledgedAt: null,
      createdAt: "2026-09-25T00:00:00.000Z",
    };
  }

  /** Commit then notify, as the host store does. */
  append(sequence: number, notify = true): void {
    const row = this.row(sequence);

    this.rows.push(row);
    if (notify) for (const listener of this.listeners) listener(row);
  }

  notify(row: HostRuntimeEventRow): void {
    for (const listener of this.listeners) listener(row);
  }

  page(cursor: string | null): HostRuntimeEventRow[] {
    if (this.failNext) {
      const error = this.failNext;

      this.failNext = null;
      throw error;
    }
    const after = cursor === null ? -1n : BigInt(cursor);

    return this.rows
      .filter((row) => BigInt(row.sequence) > after)
      .slice(0, this.pageSize);
  }

  subscribe(listener: (row: HostRuntimeEventRow) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  get subscribers(): number {
    return this.listeners.size;
  }
}

const logger = pino({ level: "silent" });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function open(outbox: Outbox, sink: HeldSink, cursor: string | null = null) {
  const registry = new RuntimeEventSubscribers(logger);
  const subscriber = registry.open({
    streamId: STREAM,
    afterSequence: cursor,
    firstPage: outbox.page(cursor),
    source: outbox,
    sink,
  });

  return { registry, subscriber };
}

describe("runtime event subscriber pump", () => {
  it("pages the backlog on one connection, then goes live", async () => {
    const outbox = new Outbox(3);

    for (let sequence = 0; sequence < 8; sequence += 1)
      outbox.append(sequence, false);
    const sink = new HeldSink();

    sink.flowing = true;
    open(outbox, sink);
    await tick();
    outbox.append(8);
    await tick();

    expect(sink.sequences()).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ]);
  });

  it("pauses on a full socket and resumes after drain from the last written sequence", async () => {
    const outbox = new Outbox(3);

    for (let sequence = 0; sequence < 6; sequence += 1)
      outbox.append(sequence, false);
    const sink = new HeldSink();
    const { registry } = open(outbox, sink);

    await tick();
    // The frame whose write returned false was buffered: it is delivered.
    expect(sink.sequences()).toEqual(["0"]);
    expect(registry.counters().subscriberPauses).toBe(1);
    // Appends while paused are read from the outbox, not queued.
    outbox.append(6);
    await sink.flush();

    expect(sink.sequences()).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(registry.counters().closes).toEqual({
      disconnect: 0,
      protocol: 0,
      floor: 0,
      shutdown: 0,
    });
  });

  it("turns a live gap into a catch-up read", async () => {
    const outbox = new Outbox(10);
    const sink = new HeldSink();

    sink.flowing = true;
    open(outbox, sink);
    await tick();
    outbox.append(0);
    outbox.append(1, false);
    outbox.append(2, false);
    outbox.notify(outbox.rows[2]!);
    await tick();
    // A duplicate notification never writes twice.
    outbox.notify(outbox.rows[1]!);
    await tick();

    expect(sink.sequences()).toEqual(["0", "1", "2"]);
  });

  it("closes protocol on a live event from another stream", async () => {
    const outbox = new Outbox();
    const sink = new HeldSink();

    sink.flowing = true;
    const { registry, subscriber } = open(outbox, sink);

    await tick();
    outbox.notify(outbox.row(0, "0b1d7c4e-2f3a-4e5b-8c6d-9e0f1a2b3c4d"));

    expect(subscriber.isClosed).toBe(true);
    expect(registry.counters().closes.protocol).toBe(1);
    expect(outbox.subscribers).toBe(0);
    expect(sink.writableEnded).toBe(true);
  });

  it.each([
    ["replay_floor_exceeded", "floor"],
    ["stream_corrupt", "protocol"],
    ["stream_identity_conflict", "protocol"],
    ["runtime_storage_unavailable", "protocol"],
  ] as const)(
    "closes a catch-up read that fails %s as %s",
    async (reason, closeReason) => {
      const outbox = new Outbox(1);

      outbox.append(0, false);
      outbox.append(1, false);
      const sink = new HeldSink();

      sink.flowing = true;
      const registry = new RuntimeEventSubscribers(logger);
      const firstPage = outbox.page(null);

      // The pump reads its next page synchronously inside open().
      outbox.failNext = new HostRuntimeEventError(reason, "page failed");
      const subscriber = registry.open({
        streamId: STREAM,
        afterSequence: null,
        firstPage,
        source: outbox,
        sink,
      });

      await tick();

      expect(sink.sequences()).toEqual(["0"]);
      expect(subscriber.isClosed).toBe(true);
      expect(registry.counters().closes[closeReason]).toBe(1);
    },
  );

  it("settles a pending drain wait when closed during a pause", async () => {
    const outbox = new Outbox();

    outbox.append(0, false);
    outbox.append(1, false);
    const sink = new HeldSink();
    const { registry, subscriber } = open(outbox, sink);

    await tick();
    expect(sink.listenerCount("drain")).toBeGreaterThan(0);
    subscriber.close("disconnect");
    await tick();

    expect(sink.listenerCount("drain")).toBe(0);
    expect(registry.counters().closes.disconnect).toBe(1);
    await sink.flush();
    // Nothing is pumped into an ended response.
    expect(sink.sequences()).toEqual(["0"]);
  });

  it("ends every open subscriber on shutdown, counting it once", async () => {
    const outbox = new Outbox();
    const registry = new RuntimeEventSubscribers(logger);
    const sinks = [new HeldSink(), new HeldSink()];

    for (const sink of sinks)
      registry.open({
        streamId: STREAM,
        afterSequence: null,
        firstPage: [],
        source: outbox,
        sink,
      });
    registry.closeAll("shutdown");
    registry.closeAll("shutdown");

    expect(registry.openCount).toBe(0);
    expect(registry.counters().closes.shutdown).toBe(2);
    expect(sinks.every((sink) => sink.writableEnded)).toBe(true);
  });
});
