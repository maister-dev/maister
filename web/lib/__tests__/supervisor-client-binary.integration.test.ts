import { rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  adoptWorkspace,
  type WireEnvelope,
  type WireCommandFence,
  getRuntimeObjectContent,
  openRuntimeObjectContent,
  uploadRuntimeObject,
  reserveRuntimeObject,
} from "@/lib/supervisor-client";
import { startRealSupervisor } from "@/test-support/real-supervisor";
import { verifyRuntimeObjectResponse } from "@/lib/execution-host/runtime-object-response";

function envelope<T>(
  kind: string,
  fence: WireCommandFence,
  payload: T,
): WireEnvelope<T> {
  return {
    command: { id: randomUUID(), kind, issuedAt: new Date().toISOString() },
    fence,
    payload,
  };
}

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
  it("reserves, uploads and reads exact full/range bytes through the real supervisor HTTP and SQLite registry", async () => {
    const host = await startRealSupervisor();
    const health = (await fetch(`${host.url}/health`).then((response) =>
      response.json(),
    )) as { host: { hostKey: string } };
    const fence = {
      hostKey: health.host.hostKey,
      runId: randomUUID(),
      assignmentId: randomUUID(),
      assignmentEpoch: 1,
    };
    const bytes = new Uint8Array([0, 255, 195, 169, 10, 32]);
    const objectId = randomUUID();
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    try {
      process.env.MAISTER_SUPERVISOR_URL = host.url;
      await adoptWorkspace(
        envelope("workspace.adopt", fence, {
          runId: fence.runId,
          projectSlug: "binary-test",
          kind: "directory",
          path: host.runtimeRoot,
        }),
      );
      const reserved = await reserveRuntimeObject(
        envelope("runtime_object.reserve", fence, {
          objectId,
          kind: "capability_instructions",
          logicalName: "binary.md",
          mimeType: "application/octet-stream",
          sizeBytes: bytes.byteLength,
          sha256,
          generation: 1,
          retentionClass: "run",
        }),
      );

      expect(reserved.state).toBe("pending");
      const uploaded = await uploadRuntimeObject({
        objectId,
        bytes,
        envelope: envelope("runtime_object.upload", fence, {
          generation: 1,
          sizeBytes: bytes.byteLength,
          sha256,
        }),
      });

      expect(uploaded.state).toBe("available");
      expect((await getRuntimeObjectContent(objectId)).bytes).toEqual(bytes);
      const range = await getRuntimeObjectContent(objectId, {
        range: { start: 2, end: 4 },
      });

      expect(range.bytes).toEqual(bytes.slice(2, 5));
      expect(range.contentRange).toBe("bytes 2-4/6");
    } finally {
      await host.stop();
      await rm(host.runtimeRoot, { recursive: true, force: true });
    }
  });

  it.each([
    "body",
    "duplicate digest",
    "malformed digest",
    "range fallback",
    "weak etag",
    "representation",
    "compression",
    "oversized length",
    "unsolicited range",
  ] as const)(
    "refuses unverified response %s over real HTTP",
    async (fault) => {
      const bytes = new TextEncoder().encode("verified bytes");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const digest = `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`;

      await serve((_request, response) => {
        response.writeHead(fault === "unsolicited range" ? 206 : 200, {
          "content-type": "application/octet-stream",
          "content-length": String(
            fault === "oversized length" ? 8 * 1024 * 1024 + 1 : bytes.length,
          ),
          "content-digest":
            fault === "duplicate digest"
              ? `${digest}, ${digest}`
              : fault === "malformed digest"
                ? "sha-256=:YQ==:"
                : digest,
          "repr-digest":
            fault === "representation"
              ? `sha-256=:${Buffer.alloc(32).toString("base64")}:`
              : digest,
          etag: `${fault === "weak etag" ? "W/" : ""}"1-${sha256}"`,
          ...(fault === "compression" ? { "content-encoding": "gzip" } : {}),
        });
        response.end(
          fault === "body" ? Buffer.alloc(bytes.length, 120) : bytes,
        );
      });
      await expect(
        getRuntimeObjectContent(
          randomUUID(),
          fault === "range fallback" ? { range: { start: 2, end: 4 } } : {},
        ),
      ).rejects.toMatchObject({
        code: "ACP_PROTOCOL",
        details: { reason: "runtime_object_integrity_mismatch" },
      });
    },
  );

  it("bounds anonymous response spools and releases slots on cancellation and complete reads", async () => {
    const bytes = new TextEncoder().encode("bounded response");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const digest = `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`;

    await serve((_request, response) => {
      response.writeHead(200, {
        "content-length": bytes.length,
        "content-digest": digest,
        "repr-digest": digest,
        etag: `"1-${sha256}"`,
      });
      response.end(bytes);
    });
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const first = await verifyRuntimeObjectResponse(
        await openRuntimeObjectContent(randomUUID()),
      );
      const second = await verifyRuntimeObjectResponse(
        await openRuntimeObjectContent(randomUUID()),
      );

      try {
        await expect(
          verifyRuntimeObjectResponse(
            await openRuntimeObjectContent(randomUUID()),
          ),
        ).rejects.toMatchObject({
          code: "EXECUTOR_UNAVAILABLE",
          details: { reason: "command_in_progress" },
        });
        await first.body.cancel();
        expect((await getRuntimeObjectContent(randomUUID())).bytes).toEqual(
          bytes,
        );
        expect(
          new Uint8Array(await new Response(second.body).arrayBuffer()),
        ).toEqual(bytes);
      } finally {
        await first.body.cancel();
        if (!second.body.locked) await second.body.cancel();
      }
    }
  });

  it("cancels a stalled verification scan and frees its descriptor and peer connection", async () => {
    const abort = new AbortController();
    const seen = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const bytes = new Uint8Array([1, 2, 3]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const digest = `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`;
    let requests = 0;

    await serve((_request, response) => {
      requests += 1;
      response.once("close", () => closed.resolve());
      response.writeHead(200, {
        "content-digest": digest,
        "repr-digest": digest,
        etag: `"1-${sha256}"`,
      });
      response.write(bytes);
      if (requests > 1) response.end();
    });
    const opened = await openRuntimeObjectContent(randomUUID());
    const body = opened.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          seen.resolve();
        },
      }),
    );
    const pending = verifyRuntimeObjectResponse(
      { ...opened, body },
      { signal: abort.signal },
    );
    const refused = expect(pending).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "aborted" },
    });

    await seen.promise;
    abort.abort();
    await refused;
    await closed.promise;
    const first = await verifyRuntimeObjectResponse(
      await openRuntimeObjectContent(randomUUID()),
    );
    const second = await verifyRuntimeObjectResponse(
      await openRuntimeObjectContent(randomUUID()),
    );

    await first.body.cancel();
    await second.body.cancel();
  });

  it("refuses an oversized chunked body without trusting an absent content length", async () => {
    const sha256 = createHash("sha256").digest("hex");
    const digest = `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`;

    await serve((_request, response) => {
      response.writeHead(200, {
        "content-digest": digest,
        "repr-digest": digest,
        etag: `"1-${sha256}"`,
      });
      const chunk = new Uint8Array(1024 * 1024);

      for (let index = 0; index < 9; index += 1) response.write(chunk);
      response.end();
    });
    await expect(getRuntimeObjectContent(randomUUID())).rejects.toMatchObject({
      code: "ACP_PROTOCOL",
      details: { reason: "runtime_object_integrity_mismatch" },
    });
  });

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
    const sha256 = createHash("sha256")
      .update(new Uint8Array([0, 255, 195, 169, 10]))
      .digest("hex");
    const digest = `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`;

    await serve((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-digest": digest,
        "repr-digest": digest,
        etag: `"1-${sha256}"`,
      });
      response.write(Buffer.from([0, 255, 195]));
      response.end(Buffer.from([169, 10]));
    });

    const result = await getRuntimeObjectContent(randomUUID());

    expect(result.bytes).toEqual(new Uint8Array([0, 255, 195, 169, 10]));
  });

  it("keeps a truncated peer response typed when cancelling an errored stream", async () => {
    const bytes = new TextEncoder().encode("complete response");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const digest = `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`;

    await serve((_request, response) => {
      response.writeHead(200, {
        "content-length": bytes.length,
        "content-digest": digest,
        "repr-digest": digest,
        etag: `"1-${sha256}"`,
        connection: "close",
      });
      response.end(bytes.subarray(0, 3));
    });
    await expect(getRuntimeObjectContent(randomUUID())).rejects.toMatchObject({
      code: "EXECUTOR_UNAVAILABLE",
      details: { reason: "network" },
    });
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
    const sha256 = createHash("sha256")
      .update(new Uint8Array([1, 2, 3]))
      .digest("hex");
    const digest = `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`;

    await serve((_request, response) => {
      response.once("close", () => closed.resolve());
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-digest": digest,
        "repr-digest": digest,
        etag: `"1-${sha256}"`,
      });
      response.write(Buffer.from([1, 2, 3]));
    });
    const opened = await openRuntimeObjectContent(randomUUID());
    const reader = opened.body.getReader();

    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    await reader.cancel();
    await closed.promise;
  }, 2_000);
});
