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

    const belowFloor = await fetch(`${host.url}/runtime-events`);

    expect(belowFloor.status).toBe(409);
    expect(await belowFloor.json()).toMatchObject({
      details: { reason: "replay_floor_lost" },
    });

    const malformed = await fetch(`${host.url}/runtime-events`, {
      headers: { "Last-Event-ID": "1.5" },
    });

    expect(malformed.status).toBe(409);
    expect(await malformed.json()).toMatchObject({
      details: { reason: "invalid_event_sequence" },
    });
  });
});
