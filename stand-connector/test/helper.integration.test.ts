import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createStandHelper } from "../src/helper.ts";
import { openRestartJournal } from "../src/restart-journal.ts";

test("IT-CBO-02 admits the exact configured restart over mTLS and returns the original receipt on replay", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "maister-stand-helper-"));
  const certPath = join(directory, "cert.pem");
  const keyPath = join(directory, "key.pem");
  const incarnationId = randomUUID();
  const journal = openRestartJournal(
    join(directory, "state.sqlite"),
    incarnationId,
    256,
  );

  context.after(() => {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
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
  const fingerprint = new X509Certificate(cert).fingerprint256
    .replaceAll(":", "")
    .toLowerCase();
  let effects = 0;
  let healthy = true;
  const helper = createStandHelper({
    tls: { cert, key, ca: cert },
    platformCertificateSha256: fingerprint,
    platformCredential: "fixture-credential",
    target: {
      id: randomUUID(),
      companyId: randomUUID(),
      incarnationId,
      configRevision: 1,
      components: [
        {
          id: "service",
          scope: "system",
          user: null,
          unit: "fixture.service",
          actions: ["inspect", "restart", "logs", "verify"],
          healthProbe: { kind: "systemd", expectedState: "active" },
        },
      ],
    },
    journal,
    authorize: async () => ({
      decision: "allowed",
      permit: {
        permitId: randomUUID(),
        expiresAt: new Date(Date.now() + 5000).toISOString(),
      },
    }),
    authorizeReceipt: async (intent) => intent.ownerEpoch === 2,
    authorizeLogs: async (intent) => intent.ownerEpoch === 2,
    authorizeVerification: async (intent) => intent.ownerEpoch === 2,
    manager: {
      inspect: async () => ({
        invocationId: effects === 0 ? "a".repeat(32) : "b".repeat(32),
        state: healthy ? "active" : "failed",
      }),
      restart: async () => {
        effects++;
        return "received";
      },
      logs: async () => ({ text: "fixture ready", truncated: false }),
    },
  });

  helper.listen(0, "127.0.0.1");
  await once(helper, "listening");
  context.after(() => helper.close());
  const port = (helper.address() as AddressInfo).port;
  const body = {
    operationId: randomUUID(),
    targetIncarnation: incarnationId,
    componentId: "service",
    action: "restart",
    requestDigest: "a".repeat(64),
    ownerEpoch: 1,
    before: { invocationId: "a".repeat(32), state: "active" },
  };
  const post = (
    payload: unknown,
    credential = "fixture-credential",
    path = "/operations",
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const bytes = JSON.stringify(payload);
      const outgoing = request(
        `https://127.0.0.1:${port}${path}`,
        {
          ca: cert,
          cert,
          key,
          servername: "localhost",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bytes),
            "X-Maister-Platform-Token": credential,
          },
        },
        async (incoming) => {
          const chunks: Buffer[] = [];

          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        },
      );

      outgoing.on("error", reject);
      outgoing.end(bytes);
    });

  assert.equal((await post(body, "wrong")).status, 401);
  assert.equal((await post({ ...body, command: "other" })).status, 400);
  assert.equal(
    (await post({ ...body, targetIncarnation: randomUUID() })).status,
    409,
  );
  assert.equal((await post({ ...body, componentId: "missing" })).status, 404);
  assert.equal(effects, 0);
  const preflight = {
    operationId: body.operationId,
    targetIncarnation: incarnationId,
    componentId: body.componentId,
    action: "inspect",
    requestDigest: body.requestDigest,
    ownerEpoch: 2,
  };
  const beforeEffect = await post(
    preflight,
    "fixture-credential",
    `/operations/${body.operationId}/observations`,
  );

  assert.equal(beforeEffect.status, 200);
  const beforeObservation = JSON.parse(beforeEffect.body);

  assert.equal(beforeObservation.state, "active");
  assert.equal(beforeObservation.invocationId, "a".repeat(32));
  assert.equal(beforeObservation.sequence, 1);
  assert.equal(journal.read(body.operationId), null);
  assert.equal(effects, 0);
  await post(body);
  const replay = await post(body);

  assert.equal(replay.status, 202);
  assert.deepEqual(JSON.parse(replay.body), {
    operationId: body.operationId,
    targetIncarnation: incarnationId,
    requestDigest: body.requestDigest,
    receiptRevision: 3,
    sequence: 4,
    effectState: "confirmed_applied",
    permitId: journal.read(body.operationId)?.permitId,
    beforeInvocation: "a".repeat(32),
    afterInvocation: "b".repeat(32),
    observedState: "active",
    capturedAt: journal.read(body.operationId)?.capturedAt,
    reason: null,
  });
  assert.equal(
    (await post({ ...body, requestDigest: "b".repeat(64) })).status,
    409,
  );
  assert.equal(
    (
      await post({
        ...body,
        before: { ...body.before, invocationId: "c".repeat(32) },
      })
    ).status,
    409,
  );
  assert.equal(effects, 1);
  const readReceipt = (ownerEpoch: number, suffix = "") =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = request(
        `https://127.0.0.1:${port}/operations/${body.operationId}${suffix}`,
        {
          ca: cert,
          cert,
          key,
          servername: "localhost",
          headers: {
            "X-Maister-Platform-Token": "fixture-credential",
            "X-Maister-Owner-Epoch": ownerEpoch,
            "X-Maister-Request-Digest": body.requestDigest,
            "X-Maister-Component-Id": body.componentId,
          },
        },
        async (incoming) => {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  assert.equal((await readReceipt(1)).status, 403);
  const reconciled = await readReceipt(2);

  assert.equal(reconciled.status, 200);
  assert.deepEqual(JSON.parse(reconciled.body), JSON.parse(replay.body));
  assert.equal((await readReceipt(1, "/logs")).status, 403);
  const logs = await readReceipt(2, "/logs");

  assert.equal(logs.status, 200);
  assert.equal(JSON.parse(logs.body).text, "fixture ready");
  const verification = {
    operationId: body.operationId,
    targetIncarnation: incarnationId,
    componentId: body.componentId,
    action: "verify",
    requestDigest: body.requestDigest,
    ownerEpoch: 2,
    verificationNonce: randomUUID(),
    issuedAt: new Date().toISOString(),
  };
  const verify = (input: typeof verification) =>
    post(
      input,
      "fixture-credential",
      `/operations/${body.operationId}/verification`,
    );
  const verified = await verify(verification);
  const observed = JSON.parse(verified.body);

  assert.equal(verified.status, 200);
  assert.equal(observed.state, "healthy");
  assert.equal(observed.nonce, verification.verificationNonce);
  assert.ok(observed.targetSequence > JSON.parse(replay.body).sequence);
  assert.equal((await verify(verification)).status, 409);
  healthy = false;
  const later = await verify({
    ...verification,
    verificationNonce: randomUUID(),
  });

  assert.equal(later.status, 200);
  assert.equal(JSON.parse(later.body).state, "unhealthy");
  assert.equal(
    JSON.parse((await readReceipt(2)).body).effectState,
    "confirmed_applied",
  );
  assert.equal(effects, 1);
});
