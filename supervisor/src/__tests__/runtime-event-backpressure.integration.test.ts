// ADR-167 amendment 2026-09-25, H1 / H2 / shutdown: end-to-end observables of
// the pausing subscriber against a booted host and a real HTTP client whose
// response the test stops reading. The pump's state transitions are owned by
// runtime-event-subscribers.test.ts and are not re-tested here.
import type { IncomingMessage } from "node:http";

import { get } from "node:http";
import { Writable } from "node:stream";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeEventSubscribers } from "../runtime-event-subscribers";
import { SupervisorHealthResponseSchema } from "../types";

import {
  bootHost,
  cleanupRuntimeRoot,
  type BootedHost,
} from "./_fixtures/boot-host";

let host: BootedHost | undefined;

afterEach(async () => {
  await host?.stop();
  if (host) await cleanupRuntimeRoot(host.runtimeRoot);
  host = undefined;
});

// A realistic frame: a streamed agent chunk of a few hundred bytes.
const TEXT = "x".repeat(400);

function append(): number {
  const startedAt = performance.now();

  host!.hostState.appendRuntimeEvent({
    draft: {
      runId: "run-backpressure",
      assignmentId: "b213c794-fa0a-4907-ae7c-2cf2c2e8f87a",
      assignmentEpoch: 1,
      hostSessionId: "9f314433-b7e9-49b9-baf7-3a23879eae68",
      eventType: "session.update",
      occurredAt: "2026-09-25T12:00:00.000Z",
      payload: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: TEXT },
        },
      },
    },
  });

  return performance.now() - startedAt;
}

type Subscriber = {
  response: IncomingMessage;
  sequences: string[];
  ended: Promise<void>;
  isEnded(): boolean;
  waitFor(count: number, timeoutMs?: number): Promise<void>;
};

/** A real client socket: `response.pause()` stops reading, so the host's
 * socket fills exactly as behind a slow manager. */
function subscribe(paused: boolean): Promise<Subscriber> {
  return new Promise((resolve, reject) => {
    const request = get(`${host!.url}/runtime-events`, { agent: false });

    request.once("error", reject);
    request.once("response", (response) => {
      const sequences: string[] = [];
      let buffer = "";
      let ended = false;
      let wake: (() => void) | null = null;

      if (paused) response.pause();
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        buffer += chunk;
        let boundary = buffer.indexOf("\n\n");

        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);

          buffer = buffer.slice(boundary + 2);
          const id = /^id: (\d+)$/m.exec(frame)?.[1];

          if (id !== undefined) sequences.push(id);
          boundary = buffer.indexOf("\n\n");
        }
        wake?.();
      });
      const endedPromise = new Promise<void>((settle) => {
        const finish = () => {
          ended = true;
          wake?.();
          settle();
        };

        response.once("end", finish);
        response.once("close", finish);
      });

      resolve({
        response,
        sequences,
        ended: endedPromise,
        isEnded: () => ended,
        async waitFor(count, timeoutMs = 30_000) {
          const deadline = Date.now() + timeoutMs;

          while (sequences.length < count && !ended) {
            if (Date.now() > deadline)
              throw new Error(
                `received ${sequences.length}/${count} runtime events`,
              );
            await new Promise<void>((settle) => {
              wake = settle;
              setTimeout(settle, 250);
            });
            wake = null;
          }
        },
      });
    });
  });
}

async function streamHealth(): Promise<{
  subscriberPauses: number;
  closes: Record<string, number>;
}> {
  const response = await host!.app.inject({
    method: "GET",
    url: "/health?includeStream=true",
  });

  return response.json().stream;
}

function inOrder(count: number, from = 0): string[] {
  return Array.from({ length: count }, (_, index) => String(from + index));
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

describe("runtime-event subscriber backpressure (ADR-167 amendment 2026-09-25)", () => {
  it("H1: pauses a subscriber that stops reading and resumes it on the same connection", async () => {
    const subscribers = new RuntimeEventSubscribers(pino({ level: "silent" }));

    host = await bootHost({ runtimeEventSubscribers: subscribers });
    const idle = Array.from({ length: 500 }, () => append());
    const subscriber = await subscribe(true);
    const loaded = Array.from({ length: 5_000 }, () => append());

    await new Promise((resolve) => setTimeout(resolve, 200));
    const paused = await streamHealth();

    expect(paused.subscriberPauses).toBeGreaterThanOrEqual(1);
    expect(subscriber.isEnded()).toBe(false);
    // The publisher neither waits on nor queues for the paused subscriber.
    expect(p95(loaded)).toBeLessThanOrEqual(3 * p95(idle) + 2);
    // What the paused subscriber holds is its socket's write buffer — about
    // one high-water mark — not the ~5 MB of events committed behind it.
    expect(subscribers.bufferedBytes()).toBeGreaterThan(0);
    expect(subscribers.bufferedBytes()).toBeLessThan(128 * 1_024);
    subscriber.response.resume();
    await subscriber.waitFor(5_500);
    append();
    await subscriber.waitFor(5_501);

    expect(subscriber.sequences).toEqual(inOrder(5_501));
    expect(subscriber.isEnded()).toBe(false);
    expect((await streamHealth()).closes).toEqual({
      disconnect: 0,
      protocol: 0,
      floor: 0,
      shutdown: 0,
    });
    subscriber.response.destroy();
    await subscriber.ended;
  });

  it("H2: one connection pages 5 000 retained rows to the head, then goes live", async () => {
    host = await bootHost();
    for (let index = 0; index < 5_000; index += 1) append();
    const subscriber = await subscribe(false);

    await subscriber.waitFor(5_000);
    append();
    await subscriber.waitFor(5_001);

    expect(subscriber.sequences).toEqual(inOrder(5_001));
    expect(subscriber.isEnded()).toBe(false);
    subscriber.response.destroy();
    await subscriber.ended;
    await expect
      .poll(async () => (await streamHealth()).closes.disconnect)
      .toBe(1);
  });

  it("H4: health counts pauses and one disconnect, and the legacy shape stays as it was", async () => {
    host = await bootHost();
    for (let index = 0; index < 5_000; index += 1) append();
    const subscriber = await subscribe(true);

    await new Promise((resolve) => setTimeout(resolve, 200));
    subscriber.response.destroy();
    await subscriber.ended;
    await expect
      .poll(async () => (await streamHealth()).closes.disconnect)
      .toBe(1);
    const opted = await host.app.inject({
      method: "GET",
      url: "/health?includeStream=true",
    });
    const legacy = await host.app.inject({ method: "GET", url: "/health" });

    expect(SupervisorHealthResponseSchema.safeParse(opted.json()).success).toBe(
      true,
    );
    // Each drain cycle while the client's buffers filled is one pause.
    expect(opted.json().stream.subscriberPauses).toBeGreaterThanOrEqual(1);
    expect(opted.json().stream.closes).toEqual({
      disconnect: 1,
      protocol: 0,
      floor: 0,
      shutdown: 0,
    });
    expect(legacy.json()).not.toHaveProperty("stream");
  });

  it("ends a paused subscriber with the reason shutdown when the host closes", async () => {
    const closed: Array<Record<string, unknown>> = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        const entry = JSON.parse(String(chunk)) as Record<string, unknown>;

        if (entry.msg === "runtime-event-stream-closed") closed.push(entry);
        done();
      },
    });

    host = await bootHost({ logger: pino({ level: "info" }, sink) });
    for (let index = 0; index < 2_000; index += 1) append();
    const subscriber = await subscribe(true);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await streamHealth()).subscriberPauses).toBeGreaterThanOrEqual(1);
    const stopping = host.stop();
    const startedAt = Date.now();

    await stopping;
    const stopMs = Date.now() - startedAt;

    await cleanupRuntimeRoot(host.runtimeRoot);
    host = undefined;
    subscriber.response.destroy();

    expect(closed.map((entry) => entry.reason)).toEqual(["shutdown"]);
    // Ended before the server waited on the socket: no forced close at 1 s.
    expect(stopMs).toBeLessThan(1_000);
  });
});
