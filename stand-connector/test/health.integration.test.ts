import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { checkHealth } from "../src/health.ts";

test("IT-CBO-05 checks configured HTTP identity and status and bounds the response", async (context) => {
  const server = createServer((request, response) => {
    response.setHeader(
      "X-Maister-Health-Identity",
      request.url === "/wrong" ? "other" : "fixture",
    );
    response.writeHead(request.url === "/failed" ? 503 : 200);
    response.end(request.url === "/large" ? "x".repeat(16_385) : "");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const unit = {
    scope: "system",
    user: null,
    unit: "fixture.service",
  } as const;
  const unused = async (): Promise<never> => {
    throw new Error("HTTP health must not call systemd");
  };
  const probe = (path: string) =>
    checkHealth({ inspect: unused, restart: unused, logs: unused }, unit, {
      kind: "http",
      url: `http://127.0.0.1:${port}${path}`,
      expectedStatus: 200,
      expectedIdentity: "fixture",
    });

  assert.equal(await probe("/ready"), "healthy");
  assert.equal(await probe("/wrong"), "unhealthy");
  assert.equal(await probe("/failed"), "unhealthy");
  assert.equal(await probe("/large"), "inconclusive");
});
