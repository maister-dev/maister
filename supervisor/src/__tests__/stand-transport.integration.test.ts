import type { AddressInfo } from "node:net";

import { execFileSync } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { loadStandTransport } from "../stand-operations/transport";

it("IT-CBO-04 sends one exact restart request, validates the pinned peer and leaves a lost response uncertain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "maister-stand-transport-"));
  const certificateFile = join(directory, "certificate.pem");
  const keyFile = join(directory, "key.pem");
  const credentialFile = join(directory, "credential");
  const configFile = join(directory, "config.json");
  const token = "stand-transport-fixture";
  const payload = {
    operationId: randomUUID(),
    targetIncarnation: randomUUID(),
    componentId: "fixture",
    action: "restart" as const,
    requestDigest: "a".repeat(64),
    resourceKey: "b".repeat(64),
    ownerEpoch: 2,
    businessOwnerEpoch: 1,
    nodeAttemptId: null,
    beforeObservationId: randomUUID(),
    before: { state: "active" as const, invocationId: "c".repeat(32) },
  };
  let deliveries = 0;
  let reads = 0;
  let retryWarnings = 0;
  const receipt = {
    operationId: payload.operationId,
    targetIncarnation: payload.targetIncarnation,
    requestDigest: payload.requestDigest,
    receiptRevision: 3,
    sequence: 4,
    effectState: "confirmed_applied",
    permitId: randomUUID(),
    beforeInvocation: payload.before.invocationId,
    afterInvocation: "f".repeat(32),
    observedState: "active",
    capturedAt: new Date().toISOString(),
    reason: null,
  };

  try {
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
        keyFile,
        "-out",
        certificateFile,
      ],
      { stdio: "ignore" },
    );
    const [cert, key] = await Promise.all([
      readFile(certificateFile),
      readFile(keyFile),
    ]);
    const pin = new X509Certificate(cert).fingerprint256
      .replaceAll(":", "")
      .toLowerCase();
    const server = createServer(
      { cert, key, ca: cert, requestCert: true, rejectUnauthorized: true },
      async (request, response) => {
        expect(request.headers["x-maister-platform-token"]).toBe(token);
        if (request.url === `/operations/${payload.operationId}/logs`) {
          expect(request.headers["x-maister-component-id"]).toBe(
            payload.componentId,
          );
          response.end(
            JSON.stringify({
              operationId: payload.operationId,
              targetIncarnation: payload.targetIncarnation,
              text: "ready",
              truncated: false,
              sanitized: true,
              capturedAt: receipt.capturedAt,
            }),
          );

          return;
        }
        if (request.url === `/operations/${payload.operationId}/verification`) {
          const chunks: Buffer[] = [];

          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

          expect(body).toMatchObject({
            action: "verify",
            requestDigest: payload.requestDigest,
            ownerEpoch: 4,
          });
          response.end(
            JSON.stringify({
              id: randomUUID(),
              operationId: payload.operationId,
              targetIncarnation: payload.targetIncarnation,
              nonce: body.verificationNonce,
              state: "healthy",
              issuedAt: body.issuedAt,
              observedAt: new Date().toISOString(),
              targetSequence: receipt.sequence + 1,
              evidenceIds: [],
              reason: null,
            }),
          );

          return;
        }
        if (request.url === `/operations/${payload.operationId}/observations`) {
          const chunks: Buffer[] = [];

          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          expect(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          ).toMatchObject({
            action: "inspect",
            ownerEpoch: 1,
            requestDigest: payload.requestDigest,
          });
          response.end(
            JSON.stringify({
              operationId: payload.operationId,
              targetIncarnation: payload.targetIncarnation,
              requestDigest: payload.requestDigest,
              resourceKey: payload.resourceKey,
              sequence: 1,
              invocationId: payload.before.invocationId,
              state: "active",
              capturedAt: receipt.capturedAt,
            }),
          );

          return;
        }
        if (request.method === "GET") {
          expect(request.url).toBe(`/operations/${payload.operationId}`);
          expect(request.headers["x-maister-request-digest"]).toBe(
            payload.requestDigest,
          );
          expect(request.headers["x-maister-owner-epoch"]).toBe("3");
          reads++;
          if (reads === 1) {
            request.socket.destroy();

            return;
          }
          response.end(JSON.stringify(receipt));

          return;
        }
        expect(request.url).toBe("/operations");
        const chunks: Buffer[] = [];

        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
          operationId: payload.operationId,
          targetIncarnation: payload.targetIncarnation,
          componentId: payload.componentId,
          action: payload.action,
          requestDigest: payload.requestDigest,
          ownerEpoch: payload.ownerEpoch,
          before: payload.before,
        });
        deliveries++;
        request.socket.destroy();
        response.end();
      },
    );

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const port = (server.address() as AddressInfo).port;
      const config = {
        incarnationId: payload.targetIncarnation,
        origin: `https://127.0.0.1:${port}`,
        serverName: "localhost",
        certificateSha256: pin,
        caFile: certificateFile,
        certificateFile,
        keyFile,
        credentialFile,
      };

      await writeFile(credentialFile, token, { mode: 0o600 });
      await writeFile(
        configFile,
        JSON.stringify([{ ...config, certificateSha256: "d".repeat(64) }]),
      );
      const logger = {
        warn: () => {
          retryWarnings++;
        },
      };
      const wrongPin = loadStandTransport(configFile, logger).dispatch;

      await expect(wrongPin(payload)).rejects.toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
      });
      expect(deliveries).toBe(0);
      await writeFile(configFile, JSON.stringify([config]));
      const transport = loadStandTransport(configFile, logger);

      await expect(
        transport.observe({
          operationId: payload.operationId,
          targetIncarnation: payload.targetIncarnation,
          requestDigest: payload.requestDigest,
          resourceKey: payload.resourceKey,
          componentId: payload.componentId,
          ownerEpoch: 1,
        }),
      ).resolves.toMatchObject({ state: "active", sequence: 1 });
      expect(deliveries).toBe(0);
      await expect(
        transport.logs({
          operationId: payload.operationId,
          targetIncarnation: payload.targetIncarnation,
          requestDigest: payload.requestDigest,
          ownerEpoch: 1,
          componentId: payload.componentId,
        }),
      ).resolves.toMatchObject({ sanitized: true, text: "ready" });
      await expect(transport.dispatch(payload)).rejects.toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
      });
      expect(deliveries).toBe(1);
      await expect(
        transport.readReceipt({
          operationId: payload.operationId,
          targetIncarnation: payload.targetIncarnation,
          requestDigest: payload.requestDigest,
          ownerEpoch: 3,
        }),
      ).resolves.toEqual(receipt);
      expect(deliveries).toBe(1);
      expect(reads).toBe(2);
      expect(retryWarnings).toBe(1);
      const verificationNonce = randomUUID();

      await expect(
        transport.verify({
          operationId: payload.operationId,
          targetIncarnation: payload.targetIncarnation,
          requestDigest: payload.requestDigest,
          ownerEpoch: 4,
          componentId: payload.componentId,
          verificationNonce,
          issuedAt: new Date().toISOString(),
        }),
      ).resolves.toMatchObject({
        state: "healthy",
        nonce: verificationNonce,
        targetSequence: receipt.sequence + 1,
      });
      expect(deliveries).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
