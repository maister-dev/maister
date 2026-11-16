import type { AddressInfo } from "node:net";

import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const exec = promisify(execFile);

it("IT-CBO-02 accepts only a CA-verified peer and derives callback identity from its certificate", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "maister-stand-mtls-"));
  const run = (args: string[]) =>
    exec("openssl", args, { cwd: fixture, timeout: 5_000 });

  try {
    await run([
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-subj",
      "/CN=Disposable MAIster test CA",
      "-days",
      "1",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
    ]);
    await Promise.all(
      (["server", "helper"] as const).map(async (role) => {
        const usage = role === "server" ? "serverAuth" : "clientAuth";
        const subject = role === "server" ? "authority" : "helper";

        await writeFile(
          join(fixture, `${role}.ext`),
          `extendedKeyUsage=${usage}\nsubjectAltName=DNS:${subject}.test,IP:127.0.0.1\n`,
        );
        await run([
          "req",
          "-new",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-nodes",
          "-subj",
          `/CN=${subject}.test`,
          "-keyout",
          `${role}.key`,
          "-out",
          `${role}.csr`,
        ]);
        await run([
          "x509",
          "-req",
          "-in",
          `${role}.csr`,
          "-CA",
          "ca.pem",
          "-CAkey",
          "ca.key",
          "-set_serial",
          role === "server" ? "2" : "3",
          "-days",
          "1",
          "-extfile",
          `${role}.ext`,
          "-out",
          `${role}.pem`,
        ]);
      }),
    );
    const load = (name: string) => readFile(join(fixture, name));
    const [ca, cert, key, helperCert, helperKey] = await Promise.all([
      load("ca.pem"),
      load("server.pem"),
      load("server.key"),
      load("helper.pem"),
      load("helper.key"),
    ]);
    const { startStandAuthorityIngress } = await import("../authority-ingress");
    const calls: Array<{ operationId: string; fingerprint: string }> = [];
    const ingress = await startStandAuthorityIngress(
      { ca, cert, key },
      { port: 0, host: "127.0.0.1" },
      async (input) => {
        calls.push({
          operationId: input.operationId,
          fingerprint: input.peerFingerprint,
        });

        return { status: 200, body: { accepted: true } };
      },
    );

    try {
      const { port } = ingress.address as AddressInfo;
      const send = (
        path: string,
        credentials?: { cert: Buffer; key: Buffer },
        body = "{}",
      ) =>
        new Promise<number | undefined>((resolve, reject) => {
          const req = request(
            {
              hostname: "127.0.0.1",
              port,
              path,
              method: "POST",
              ca,
              ...credentials,
              headers: {
                "content-type": "application/json",
                "x-maister-helper-token": "test-credential",
                "x-maister-helper-fingerprint": "forged",
              },
            },
            (res) => {
              res.resume();
              res.once("end", () => resolve(res.statusCode));
            },
          );

          req.once("error", reject);
          req.end(body);
        });
      const path =
        "/api/stand-operations/operation-fixture/authorizations/check";
      const credentials = { cert: helperCert, key: helperKey };

      await expect(send(path)).rejects.toThrow();
      expect(await send("/api/stands", credentials)).toBe(404);
      expect(await send(path, credentials, "{}".padEnd(65_537))).toBe(413);
      expect(await send(path, credentials)).toBe(200);
      expect(calls).toEqual([
        {
          operationId: "operation-fixture",
          fingerprint: new X509Certificate(helperCert).fingerprint256,
        },
      ]);
    } finally {
      await ingress.close();
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
