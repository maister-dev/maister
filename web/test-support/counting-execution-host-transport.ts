// R20 load control (ADR-167 amendment 2026-09-25): observes the event plane
// from the manager's side of the wire without sitting in it. The fault proxy
// cannot be used for this — it parses and forwards frames eagerly, so a manager
// behind it never fills the HOST's socket and host backpressure never happens.
// This wrapper only counts; every call reaches the wrapped transport unchanged.
import type { Logger } from "pino";
import type { ExecutionHostTransport } from "@/lib/execution-host/contracts";

import { Writable } from "node:stream";

import pino from "pino";

export type TransportCounts = {
  streamOpens: number;
  /** The host ended a stream the consumer had not aborted or left. */
  serverEndedCloses: number;
  /** A stream failed while the consumer had not aborted it. */
  streamErrors: number;
  /** The consumer left the stream (break, maxEvents, claim lost) or aborted. */
  consumerEndedCloses: number;
  eventsDelivered: number;
  ackRequests: number;
};

export function countingTransport(inner: ExecutionHostTransport): {
  transport: ExecutionHostTransport;
  counts: TransportCounts;
} {
  const counts: TransportCounts = {
    streamOpens: 0,
    serverEndedCloses: 0,
    streamErrors: 0,
    consumerEndedCloses: 0,
    eventsDelivered: 0,
    ackRequests: 0,
  };
  const transport: ExecutionHostTransport = {
    ...inner,
    async *streamRuntimeEvents(opts) {
      counts.streamOpens += 1;
      let outcome: "server" | "error" | "consumer" = "consumer";

      try {
        for await (const envelope of inner.streamRuntimeEvents(opts)) {
          counts.eventsDelivered += 1;
          yield envelope;
        }
        outcome = opts?.signal?.aborted ? "consumer" : "server";
      } catch (error) {
        outcome = opts?.signal?.aborted ? "consumer" : "error";
        throw error;
      } finally {
        if (outcome === "server") counts.serverEndedCloses += 1;
        else if (outcome === "error") counts.streamErrors += 1;
        else counts.consumerEndedCloses += 1;
      }
    },
    acknowledgeRuntimeEvents(input) {
      counts.ackRequests += 1;

      return inner.acknowledgeRuntimeEvents(input);
    },
  };

  return { transport, counts };
}

/** A structured logger that counts lines by message and keeps the last few
 * warnings, so a harness can read per-batch evidence the consumer logs. */
export function countingLogger(level: string = "info"): {
  logger: Logger;
  count(message: string): number;
  /** Sum of a numeric field over every line with this message. */
  sum(message: string, field: string): number;
  warnings(): readonly Record<string, unknown>[];
} {
  const counts = new Map<string, number>();
  const sums = new Map<string, number>();
  const warnings: Record<string, unknown>[] = [];
  let partial = "";
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      const text = partial + chunk.toString("utf8");
      const lines = text.split("\n");

      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const entry = JSON.parse(line) as Record<string, unknown>;
        const message = String(entry.msg ?? "");

        counts.set(message, (counts.get(message) ?? 0) + 1);
        for (const [field, value] of Object.entries(entry)) {
          if (
            typeof value !== "number" ||
            field === "level" ||
            field === "time"
          )
            continue;
          const key = `${message}\u0000${field}`;

          sums.set(key, (sums.get(key) ?? 0) + value);
        }
        if (typeof entry.level === "number" && entry.level >= 40) {
          warnings.push(entry);
          if (warnings.length > 50) warnings.shift();
        }
      }
      done();
    },
  });

  return {
    logger: pino({ level }, sink),
    count: (message) => counts.get(message) ?? 0,
    sum: (message, field) => sums.get(`${message}\u0000${field}`) ?? 0,
    warnings: () => warnings,
  };
}
