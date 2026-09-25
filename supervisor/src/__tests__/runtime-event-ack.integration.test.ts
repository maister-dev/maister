import { get } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  bootHost,
  cleanupRuntimeRoot,
  type BootedHost,
} from "./_fixtures/boot-host";

let host: BootedHost | undefined;

type RuntimeSseEvent = {
  id: string;
  event: string;
  data: { sequence: string; eventType: string };
};

function appendEvent(eventType: "session.created" | "session.command") {
  if (!host) throw new Error("host is not booted");

  return host.hostState.appendRuntimeEvent({
    draft: {
      runId: "run-event-ack",
      assignmentId: "b213c794-fa0a-4907-ae7c-2cf2c2e8f87a",
      assignmentEpoch: 1,
      hostSessionId: "9f314433-b7e9-49b9-baf7-3a23879eae68",
      eventType,
      occurredAt: "2026-09-04T12:00:00.000Z",
      payload: { sourceMonotonicId: 1 },
    },
    terminal: eventType === "session.command",
  });
}

async function collectRuntimeSse(
  url: string,
  expectedCount: number,
  lastEventId?: string,
): Promise<RuntimeSseEvent[]> {
  const controller = new AbortController();
  const response = await fetch(url, {
    signal: controller.signal,
    headers: lastEventId ? { "Last-Event-ID": lastEventId } : undefined,
  });

  if (!response.ok || !response.body) {
    throw new Error(`runtime SSE failed: ${response.status}`);
  }

  const events: RuntimeSseEvent[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id = "";
  let event = "";
  let data = "";

  try {
    while (events.length < expectedCount) {
      const next = await reader.read();

      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let newline = buffer.indexOf("\n");

      while (newline !== -1) {
        const line = buffer.slice(0, newline);

        buffer = buffer.slice(newline + 1);
        if (line === "") {
          events.push({
            id,
            event,
            data: JSON.parse(data) as RuntimeSseEvent["data"],
          });
          id = "";
          event = "";
          data = "";
          if (events.length === expectedCount) controller.abort();
        } else if (line.startsWith("id: ")) {
          id = line.slice(4);
        } else if (line.startsWith("event: ")) {
          event = line.slice(7);
        } else if (line.startsWith("data: ")) {
          data = line.slice(6);
        }
        newline = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    if ((error as Error).name !== "AbortError") throw error;
  }

  return events;
}

afterEach(async () => {
  await host?.stop();
  if (host) await cleanupRuntimeRoot(host.runtimeRoot);
  host = undefined;
});

describe("Stage B host runtime-event acknowledgement", () => {
  it("requires the current stream identity and a contiguous absolute watermark", async () => {
    host = await bootHost();
    const streamId = host.hostState.getRuntimeEventStreamId();

    appendEvent("session.created");

    const foreign = await host.app.inject({
      method: "POST",
      url: "/runtime-events/ack",
      payload: {
        streamId: "76103277-0889-49d7-87f1-f0fd2f5f5922",
        throughSequence: "0",
      },
    });

    expect(foreign.statusCode).toBe(409);
    expect(foreign.json().details.reason).toBe("stream_identity_conflict");

    const accepted = await host.app.inject({
      method: "POST",
      url: "/runtime-events/ack",
      payload: { streamId, throughSequence: "0" },
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ streamId, acknowledgedThrough: "0" });
  });

  it("replays strictly after the decimal cursor and fails explicitly below the replay floor", async () => {
    let clock = Date.now();

    host = await bootHost({ now: () => new Date(clock) });
    const streamId = host.hostState.getRuntimeEventStreamId();

    appendEvent("session.created");
    appendEvent("session.command");

    const replayed = await collectRuntimeSse(
      `${host.url}/runtime-events`,
      1,
      "0",
    );

    expect(replayed).toEqual([
      expect.objectContaining({
        id: "1",
        event: "session.command",
        data: expect.objectContaining({ sequence: "1" }),
      }),
    ]);

    host.hostState.ackRuntimeEvents(streamId, "0");
    clock += host.hostState.limits.eventAckGraceMs + 1;
    expect(
      host.hostState.pruneAcknowledgedRuntimeEvents(
        new Date(clock - host.hostState.limits.eventAckGraceMs),
      ),
    ).toBe(1);

    // Omission starts AT the retained floor — a manager with no durable
    // watermark must be able to bootstrap. This used to answer 409, which wedged
    // it against any host that had ever pruned.
    const fromFloor = await collectRuntimeSse(`${host.url}/runtime-events`, 1);

    expect(fromFloor).toEqual([
      expect.objectContaining({
        id: "1",
        data: expect.objectContaining({ sequence: "1" }),
      }),
    ]);

    host.hostState.ackRuntimeEvents(streamId, "1");
    clock += host.hostState.limits.eventAckGraceMs + 1;
    expect(
      host.hostState.pruneAcknowledgedRuntimeEvents(
        new Date(clock - host.hostState.limits.eventAckGraceMs),
      ),
    ).toBe(1);

    const belowFloor = await fetch(`${host.url}/runtime-events`, {
      headers: { "Last-Event-ID": "0" },
    });

    expect(belowFloor.status).toBe(409);

    const belowFloorBody = (await belowFloor.json()) as {
      message: string;
      details: { reason: string };
    };

    expect(belowFloorBody).toMatchObject({
      details: { reason: "replay_floor_lost" },
    });
    // The refusal must name the cursor it rejected, not only the floor —
    // without it the message reads as an inverted comparison.
    expect(belowFloorBody.message).toContain("0");
    expect(belowFloorBody.message).toContain("1");

    const malformed = await fetch(`${host.url}/runtime-events`, {
      headers: { "Last-Event-ID": "1.5" },
    });

    expect(malformed.status).toBe(409);
    expect(await malformed.json()).toMatchObject({
      details: { reason: "invalid_event_sequence" },
    });
  });

  it("closes a paused subscriber whose catch-up read fell below a floor pruned under it", async () => {
    // ADR-167 amendment 2026-09-25 (EDGE-EVT-10): a second, lagging
    // subscriber can fall below the floor another subscriber's ACK moved.
    let clock = Date.now();

    host = await bootHost({ now: () => new Date(clock) });
    const streamId = host.hostState.getRuntimeEventStreamId();

    for (let index = 0; index < 5_000; index += 1)
      appendEvent("session.created");
    const received: string[] = [];
    const response = await new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        const request = get(`${host!.url}/runtime-events`, { agent: false });

        request.once("error", reject);
        request.once("response", resolve);
      },
    );

    response.pause();
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      for (const match of chunk.matchAll(/^id: (\d+)$/gm))
        received.push(match[1]!);
    });
    const ended = new Promise<void>((resolve) => response.once("end", resolve));

    await new Promise((resolve) => setTimeout(resolve, 200));
    host.hostState.ackRuntimeEvents(streamId, "4999");
    clock += host.hostState.limits.eventAckGraceMs + 1;
    let pruned = 0;

    // Pruning is bounded per call; drain it.
    for (;;) {
      const batch = host.hostState.pruneAcknowledgedRuntimeEvents(
        new Date(clock - host.hostState.limits.eventAckGraceMs),
      );

      if (batch === 0) break;
      pruned += batch;
    }
    expect(pruned).toBe(5_000);
    response.resume();
    await ended;
    const health = await host.app.inject({
      method: "GET",
      url: "/health?includeStream=true",
    });

    // The connection ends at the floor; the frames already buffered arrive.
    expect(received.length).toBeGreaterThan(0);
    expect(received.length).toBeLessThan(5_000);
    expect(health.json().stream.closes).toMatchObject({
      floor: 1,
      protocol: 0,
    });
    // The manager's reconnect then meets the open-time refusal (EDGE-EVT-03).
    const reopened = await fetch(`${host.url}/runtime-events`, {
      headers: { "Last-Event-ID": received.at(-1)! },
    });

    expect(reopened.status).toBe(409);
    expect(await reopened.json()).toMatchObject({
      details: { reason: "replay_floor_lost" },
    });
  });
});
