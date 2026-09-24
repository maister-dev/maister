// ADR-167 D5 amendment (2026-09-23) — `GET /runtime-events/span` serves one
// bounded page of the retained outbox range `(after, through]` so a manager can
// verify a finished turn before the shared stream is ingested. It is a read:
// the acknowledgement, the retained rows and the replay floor never move.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  RuntimeEventSpanSchema,
  type RuntimeEventSpan,
} from "../runtime-events";

import { bootHost, type BootedHost } from "./_fixtures/boot-host";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The documented refusal examples, so the wire answer and the docs agree. */
function documentedRefusal(
  status: "409" | "503",
  name: string,
): Record<string, unknown> {
  const openapi = parse(
    readFileSync(
      resolve(
        fileURLToPath(import.meta.url),
        "../../../../docs/api/supervisor.openapi.yaml",
      ),
      "utf8",
    ),
  );

  return openapi.paths["/runtime-events/span"].get.responses[status].content[
    "application/json"
  ].examples[name].value;
}

let host: BootedHost | null = null;

afterEach(async () => {
  await host?.stop();
  host = null;
});

function append(state: BootedHost["hostState"], payloadBytes = 0) {
  return state.appendRuntimeEvent({
    draft: {
      runId: "run-event-span",
      assignmentId: "b213c794-fa0a-4907-ae7c-2cf2c2e8f87a",
      assignmentEpoch: 1,
      hostSessionId: "9f314433-b7e9-49b9-baf7-3a23879eae68",
      eventType: "session.created",
      occurredAt: "2026-09-23T12:00:00.000Z",
      payload:
        payloadBytes > 0
          ? { text: "x".repeat(payloadBytes) }
          : { sourceMonotonicId: 1 },
    },
    terminal: false,
  });
}

async function span(
  query: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(
    `${host!.url}/runtime-events/span?${new URLSearchParams(query)}`,
  );

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function page(query: Record<string, string>): Promise<RuntimeEventSpan> {
  const { status, body } = await span(query);

  expect(status).toBe(200);

  return RuntimeEventSpanSchema.parse(body);
}

/** Envelopes the SSE replay sends for `(after, through]`. */
async function sseReplay(after: string, through: string): Promise<unknown[]> {
  const controller = new AbortController();
  const response = await fetch(`${host!.url}/runtime-events`, {
    headers: { "last-event-id": after },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const envelopes: Array<{ sequence: string }> = [];
  let buffer = "";

  try {
    while (!envelopes.some((e) => BigInt(e.sequence) >= BigInt(through))) {
      const { done, value } = await reader.read();

      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (
        let end = buffer.indexOf("\n\n");
        end !== -1;
        end = buffer.indexOf("\n\n")
      ) {
        const data = buffer
          .slice(0, end)
          .split("\n")
          .find((line) => line.startsWith("data: "));

        buffer = buffer.slice(end + 2);
        if (data) envelopes.push(JSON.parse(data.slice("data: ".length)));
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    controller.abort();
  }

  return envelopes.filter(
    (envelope) => BigInt(envelope.sequence) <= BigInt(through),
  );
}

describe("GET /runtime-events/span", () => {
  it("serves exactly the retained range, byte-identical to the SSE replay, and moves nothing", async () => {
    host = await bootHost();
    for (let index = 0; index < 6; index += 1) append(host.hostState);
    const streamId = host.hostState.getRuntimeEventStreamId();

    host.hostState.ackRuntimeEvents(streamId, "0");
    const before = host.hostState.runtimeEventOutboxStats();
    const result = await page({ streamId, after: "1", through: "4" });

    expect(result).toMatchObject({
      streamId,
      after: "1",
      through: "4",
      state: "complete",
      nextAfter: null,
    });
    expect(result.events.map((event) => event.sequence)).toEqual([
      "2",
      "3",
      "4",
    ]);
    expect(result.events).toEqual(await sseReplay("1", "4"));
    // Read-only: no acknowledgement, no prune, no retained row consumed.
    expect(host.hostState.runtimeEventOutboxStats()).toEqual(before);
  });

  it("pages at the row bound and at the byte bound, and the pages chain to the whole range", async () => {
    host = await bootHost();
    for (let index = 0; index < 502; index += 1) append(host.hostState);
    const streamId = host.hostState.getRuntimeEventStreamId();
    const first = await page({ streamId, after: "0", through: "501" });

    expect(first).toMatchObject({ state: "partial", nextAfter: "500" });
    expect(first.events).toHaveLength(500);

    await host.stop();
    host = await bootHost();
    for (let index = 0; index < 40; index += 1)
      append(host.hostState, 60 * 1024);
    const bytesStream = host.hostState.getRuntimeEventStreamId();
    const sequences: string[] = [];
    let after = "0";
    let pages = 0;

    for (;;) {
      const next = await page({ streamId: bytesStream, after, through: "39" });

      sequences.push(...next.events.map((event) => event.sequence));
      pages += 1;
      if (next.state === "complete") break;
      expect(next.state).toBe("partial");
      after = next.nextAfter!;
    }
    expect(pages).toBeGreaterThan(1);
    expect(sequences).toEqual(
      Array.from({ length: 39 }, (_, index) => String(index + 1)),
    );
  });

  it("answers a typed unavailability for a pruned range, a foreign stream and an unemitted terminal", async () => {
    let clock = new Date("2026-09-23T12:00:00.000Z");

    host = await bootHost({ now: () => clock });
    for (let index = 0; index < 6; index += 1) append(host.hostState);
    const streamId = host.hostState.getRuntimeEventStreamId();

    host.hostState.ackRuntimeEvents(streamId, "3");
    clock = new Date(clock.getTime() + 2 * DAY_MS);
    host.hostState.pruneAcknowledgedRuntimeEvents(
      new Date(clock.getTime() - DAY_MS),
    );

    expect(await page({ streamId, after: "1", through: "5" })).toMatchObject({
      state: "unavailable",
      reason: "replay_floor_lost",
      nextAfter: null,
      events: [],
    });
    expect(
      await page({ streamId: randomUUID(), after: "3", through: "5" }),
    ).toMatchObject({
      state: "unavailable",
      reason: "stream_identity_changed",
    });
    expect(await page({ streamId, after: "3", through: "6" })).toMatchObject({
      state: "unavailable",
      reason: "beyond_emitted",
    });
    // The retained tail above the floor is still served.
    expect(
      (await page({ streamId, after: "3", through: "5" })).events.map(
        (event) => event.sequence,
      ),
    ).toEqual(["4", "5"]);
  });

  it("refuses an empty, inverted or malformed range with invalid_event_span", async () => {
    host = await bootHost();
    append(host.hostState);
    append(host.hostState);
    const streamId = host.hostState.getRuntimeEventStreamId();

    for (const query of <Array<Record<string, string>>>[
      { streamId, after: "1", through: "1" },
      { streamId, after: "1", through: "0" },
      { streamId, after: "-1", through: "1" },
      { streamId, after: "01", through: "1" },
      { streamId, after: "abc", through: "1" },
      { streamId, after: "0.5", through: "1" },
      { streamId, after: "0", through: "1e3" },
      { streamId: "not-a-uuid", after: "0", through: "1" },
      { streamId, after: "0" },
    ]) {
      const { status, body } = await span(query);

      expect(status).toBe(409);
      expect(body).toEqual(documentedRefusal("409", "invalidSpan"));
    }
  });

  it("answers 503 runtime_storage_unavailable for a range whose retained rows are gone", async () => {
    host = await bootHost();
    for (let index = 0; index < 4; index += 1) append(host.hostState);
    const streamId = host.hostState.getRuntimeEventStreamId();
    const sqlite = new DatabaseSync(join(host.stateDir, "state.sqlite"));

    try {
      sqlite
        .prepare(
          "DELETE FROM runtime_event_outbox WHERE stream_id = ? AND sequence IN ('2', '3')",
        )
        .run(streamId);
    } finally {
      sqlite.close();
    }
    const { status, body } = await span({ streamId, after: "1", through: "3" });

    expect(status).toBe(503);
    expect(body).toEqual({
      ...documentedRefusal("503", "rangeNotRetained"),
      message: `runtime event span (1, 3] has no retained rows on stream ${streamId}`,
    });
    // A corrupt range is not a failed store: the host stays ready.
    expect(host.hostState.runtimeStorageAvailable()).toBe(true);
  });
});
