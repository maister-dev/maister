import { createHash, randomUUID } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  getRuntimeObjectContent,
  openRuntimeObjectContent,
  uploadRuntimeObject,
} from "@/lib/supervisor-client";

const servers: Server[] = [];
const originalUrl = process.env.MAISTER_SUPERVISOR_URL;

async function serve(handler: RequestListener): Promise<void> {
  const server = createServer(handler);

  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("binary transport fixture did not bind a TCP port");
  }
  process.env.MAISTER_SUPERVISOR_URL = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (originalUrl === undefined) delete process.env.MAISTER_SUPERVISOR_URL;
  else process.env.MAISTER_SUPERVISOR_URL = originalUrl;
});

describe("runtime-object binary HTTP transport (AT-17)", () => {
  it.each(["length", "digest", "header"] as const)(
    "refuses invalid %s before sending any request",
    async (invalid) => {
      let received = 0;

      await serve((_request, response) => {
        received += 1;
        response.writeHead(422, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ code: "ACP_PROTOCOL", message: "received" }),
        );
      });
      const bytes = new TextEncoder().encode("binary request\u0000é");
      const sha256 = createHash("sha256").update(bytes).digest("hex");

      await expect(
        uploadRuntimeObject({
          objectId: randomUUID(),
          bytes,
          timeoutMs: 500,
          envelope: {
            command: {
              id: randomUUID(),
              kind: "runtime_object.upload",
              issuedAt:
                invalid === "header" ? "bad\nheader" : new Date().toISOString(),
            },
            fence: {
              hostKey: "eh_binary_transport_test",
              runId: randomUUID(),
              assignmentId: randomUUID(),
              assignmentEpoch: 1,
            },
            payload: {
              generation: 1,
              sizeBytes: bytes.byteLength + (invalid === "length" ? 1 : 0),
              sha256: invalid === "digest" ? "0".repeat(64) : sha256,
            },
          },
        }),
      ).rejects.toMatchObject({
        code: "ACP_PROTOCOL",
        details: { transport: "not_sent", reason: "transport_request_invalid" },
      });
      expect(received).toBe(0);
    },
  );

  it("reads actual chunked bytes without a content-length header", async () => {
    await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.from([0, 255, 195]));
      response.end(Buffer.from([169, 10]));
    });

    const result = await getRuntimeObjectContent(randomUUID());

    expect(result.bytes).toEqual(new Uint8Array([0, 255, 195, 169, 10]));
  });

  it("keeps the upload deadline active after response headers", async () => {
    let received = 0;

    await serve((request, response) => {
      received += 1;
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"objectId":');
      });
    });
    const bytes = new Uint8Array([0, 255, 10]);

    await expect(
      uploadRuntimeObject({
        objectId: randomUUID(),
        bytes,
        timeoutMs: 150,
        envelope: {
          command: {
            id: randomUUID(),
            kind: "runtime_object.upload",
            issuedAt: new Date().toISOString(),
          },
          fence: {
            hostKey: "eh_binary_transport_test",
            runId: randomUUID(),
            assignmentId: randomUUID(),
            assignmentEpoch: 1,
          },
          payload: {
            generation: 1,
            sizeBytes: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { transport: "unknown_outcome", reason: "timeout" },
    });
    expect(received).toBe(1);
  }, 2_000);

  it("cancels the peer stream when the caller cancels its read", async () => {
    const closed = Promise.withResolvers<void>();

    await serve((_request, response) => {
      response.once("close", () => closed.resolve());
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.from([1, 2, 3]));
    });
    const opened = await openRuntimeObjectContent(randomUUID());
    const reader = opened.body.getReader();

    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    await reader.cancel();
    await closed.promise;
  }, 2_000);
});
