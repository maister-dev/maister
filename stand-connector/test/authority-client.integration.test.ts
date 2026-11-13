import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createAuthorityClient } from "../src/authority-client.ts";

test("IT-CBO-02 exchanges the exact dispatch nonce over TLS and rejects a changed permit", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "maister-stand-authority-"));
  const certPath = join(directory, "cert.pem");
  const keyPath = join(directory, "key.pem");

  context.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  const intent = {
    operationId: randomUUID(),
    targetIncarnation: randomUUID(),
    resourceKey: "a".repeat(64),
    requestDigest: "b".repeat(64),
    ownerEpoch: 1,
    predecessorId: randomUUID(),
  };
  const permitId = randomUUID();
  let requests = 0;
  const server = createServer(
    { cert, key, ca: cert, requestCert: true, rejectUnauthorized: true },
    async (request, response) => {
      assert.equal(
        request.url,
        `/api/stand-operations/${intent.operationId}/authorizations/check`,
      );
      assert.equal(
        request.headers["x-maister-helper-token"],
        "fixture-credential",
      );
      const chunks: Buffer[] = [];

      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

      assert.equal(body.purpose, "dispatch");
      assert.equal(body.targetIncarnation, intent.targetIncarnation);
      assert.equal(body.resourceKey, intent.resourceKey);
      assert.equal(body.ownerEpoch, intent.ownerEpoch);
      assert.equal(body.requestDigest, intent.requestDigest);
      requests++;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          ...body,
          predecessorId: requests === 3 ? randomUUID() : intent.predecessorId,
          ...(requests === 2 ? { nonce: randomUUID() } : {}),
          operationId: intent.operationId,
          permitId,
          allowed: true,
          expiresAt: new Date(Date.now() + 4900).toISOString(),
        }),
      );
    },
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  const client = createAuthorityClient({
    origin: `https://127.0.0.1:${port}`,
    serverName: "localhost",
    ca: cert,
    certificate: cert,
    key,
    credential: "fixture-credential",
  });
  const accepted = await client.authorize(intent);

  assert.equal(accepted.decision, "allowed");
  if (accepted.decision === "allowed")
    assert.equal(accepted.permit.permitId, permitId);
  await assert.rejects(client.authorize(intent), { reason: "invalid_permit" });
  await assert.rejects(client.authorize(intent), { reason: "invalid_permit" });
  assert.equal(requests, 3);
});
