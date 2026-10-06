import type { Socket } from "node:net";
import type { IncomingMessage, RequestListener } from "node:http";

import { once } from "node:events";
import { createServer, get, request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";

import { startSupervisorFaultProxy } from "../supervisor-fault-proxy";

type LoopbackServer = Readonly<{
  url: string;
  close(): Promise<void>;
}>;

async function startLoopbackServer(
  handler: RequestListener,
): Promise<LoopbackServer> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string")
    throw new Error("fault proxy control has no loopback address");

  return {
    url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function closeFixtures(
  fixtures: readonly { close(): Promise<void> }[],
): Promise<void> {
  const results = await Promise.allSettled(
    fixtures.map((fixture) => fixture.close()),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );

  if (failures.length)
    throw new AggregateError(failures, "fault proxy control cleanup failed");
}

it("HTTP cancellation: an aborted upload drains and the proxy continues forwarding", async () => {
  const upstream = await startLoopbackServer((_incoming, response) => {
    response.end("healthy");
  });
  const proxy = await startSupervisorFaultProxy(upstream.url);

  try {
    const upload = request(proxy.url, {
      method: "POST",
      headers: { Expect: "100-continue", "Content-Length": "8" },
    });

    upload.flushHeaders();
    await once(upload, "continue");
    const closed = new Promise<void>((resolve, reject) => {
      upload.once("close", resolve);
      upload.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "ECONNRESET") reject(error);
      });
    });

    upload.write("x");
    upload.destroy();
    await closed;
    const response = await fetch(proxy.url);

    expect(await response.text()).toBe("healthy");
    await delay(20);
    expect(() => proxy.assertDrained()).not.toThrow();
  } finally {
    await closeFixtures([proxy, upstream]);
  }
});

it("SSE cancellation: closing a real client during frame delivery drains and permits reconnect", async () => {
  let closedStreams = 0;
  const frame = `id: 1\ndata: ${JSON.stringify({ payload: {}, body: "x".repeat(64 * 1024) })}\n\n`;
  const upstream = await startLoopbackServer((_incoming, response) => {
    response.once("close", () => {
      closedStreams += 1;
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(frame.repeat(64));
  });
  const proxy = await startSupervisorFaultProxy(upstream.url);

  try {
    for (let index = 0; index < 16; index += 1) {
      const client = get(`${proxy.url}/runtime-events`);
      const [response] = await once(client, "response");
      const received = response as IncomingMessage;

      await once(received, "data");
      received.destroy();
      await expect.poll(() => closedStreams).toBe(index + 1);
      expect(() => proxy.assertDrained()).not.toThrow();
    }
    const response = await fetch(`${proxy.url}/runtime-events`);

    expect(await response.text()).toBe(frame.repeat(64));
    expect(() => proxy.assertDrained()).not.toThrow();
  } finally {
    await closeFixtures([proxy, upstream]);
  }
});

it("proxy refusal: malformed SSE and an unreleased barrier remain observable failures", async () => {
  const upstream = await startLoopbackServer((_incoming, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end("id: 1\ndata: {\n\n");
  });
  const proxy = await startSupervisorFaultProxy(upstream.url);

  proxy.arm(
    { caseId: "unreleased-control", method: "GET", path: /^\/unreached$/ },
    "hold-request",
  );
  try {
    await expect(
      fetch(`${proxy.url}/runtime-events`).then((response) => response.text()),
    ).rejects.toThrow();
    let failure: unknown;

    try {
      proxy.assertDrained();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      errors: [
        expect.any(SyntaxError),
        expect.objectContaining({
          name: "FaultBarrierError",
          message: "unreleased-control:hold-request:unreached",
        }),
      ],
    });
  } finally {
    await expect(proxy.close()).rejects.toThrow("fault proxy did not drain");
    await upstream.close();
  }

  const buffered = await startLoopbackServer((_incoming, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `id: 1\ndata: ${JSON.stringify({ body: "x".repeat(1024 * 1024) })}\n\nid: 2\ndata: {\n\n`,
    );
  });
  const cancelled = await startSupervisorFaultProxy(buffered.url);

  try {
    const client = get(`${cancelled.url}/runtime-events`);
    const [response] = await once(client, "response");
    const received = response as IncomingMessage;

    await once(received, "data");
    received.destroy();
    await expect
      .poll(() => {
        try {
          cancelled.assertDrained();
        } catch (error) {
          return error;
        }

        return null;
      })
      .toMatchObject({ errors: [expect.any(SyntaxError)] });
  } finally {
    await expect(cancelled.close()).rejects.toThrow(
      "fault proxy did not drain",
    );
    await buffered.close();
  }
});
