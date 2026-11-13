import type { DispatchStandRestart, StandDispatchPayload } from "./contracts";

import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { request } from "node:https";
import { isAbsolute } from "node:path";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

import { z } from "zod";

import { SupervisorError } from "../types";

const targetSchema = z
  .object({
    incarnationId: z.uuid(),
    origin: z.url({ protocol: /^https$/ }).max(2048),
    serverName: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
    certificateSha256: z.string().regex(/^[a-f0-9]{64}$/),
    caFile: z.string().refine(isAbsolute),
    certificateFile: z.string().refine(isAbsolute),
    keyFile: z.string().refine(isAbsolute),
    credentialFile: z.string().refine(isAbsolute),
  })
  .strict();

const receiptSchema = z
  .object({
    operationId: z.uuid(),
    targetIncarnation: z.uuid(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    receiptRevision: z.number().int().min(1).max(3),
    sequence: z.number().int().min(1),
    effectState: z.enum([
      "not_dispatched",
      "dispatching",
      "confirmed_applied",
      "confirmed_not_applied",
      "unknown",
    ]),
    permitId: z.uuid().nullable(),
    beforeInvocation: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    afterInvocation: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    observedState: z.enum(["active", "inactive", "failed", "unknown"]),
    capturedAt: z.iso.datetime(),
    reason: z
      .enum(["authority_refused", "before_state_changed", "effect_unknown"])
      .nullable(),
  })
  .strict();

type Target = Readonly<{
  origin: URL;
  serverName: string;
  fingerprint: Buffer;
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
  credential: string;
}>;

function invalidConfig(): SupervisorError {
  return new SupervisorError(
    "PRECONDITION",
    "Invalid stand transport configuration",
  );
}

function loadFile(path: string, maximum: number): Buffer {
  const stat = statSync(path);

  if (!stat.isFile() || stat.size > maximum) throw invalidConfig();
  const bytes = readFileSync(path);

  if (bytes.length > maximum) throw invalidConfig();

  return bytes;
}

function checkTargetCertificate(
  target: Target,
  hostname: string,
  certificate: PeerCertificate,
): Error | undefined {
  const invalidHostname = checkServerIdentity(hostname, certificate);

  if (invalidHostname) return invalidHostname;
  const actual = Buffer.from(
    certificate.fingerprint256.replaceAll(":", ""),
    "hex",
  );

  if (
    actual.length !== target.fingerprint.length ||
    !timingSafeEqual(actual, target.fingerprint)
  )
    return new Error("Stand helper certificate fingerprint changed");
}

function sendRestart(
  target: Target,
  payload: StandDispatchPayload,
): Promise<Record<string, unknown>> {
  const {
    operationId,
    targetIncarnation,
    componentId,
    action,
    requestDigest,
    ownerEpoch,
    before,
  } = payload;
  const body = JSON.stringify({
    operationId,
    targetIncarnation,
    componentId,
    action,
    requestDigest,
    ownerEpoch,
    before,
  });
  const uncertain = () =>
    new SupervisorError(
      "EXECUTOR_UNAVAILABLE",
      "The stand dispatch outcome requires reconciliation",
    );

  return new Promise((resolve, reject) => {
    const call = request(
      new URL("/operations", target.origin),
      {
        method: "POST",
        ca: target.ca,
        cert: target.cert,
        key: target.key,
        servername: target.serverName,
        checkServerIdentity: (hostname, certificate) =>
          checkTargetCertificate(target, hostname, certificate),
        minVersion: "TLSv1.2",
        agent: false,
        signal: AbortSignal.timeout(53_000),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Maister-Platform-Token": target.credential,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;

        response.on("error", () => reject(uncertain()));
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4096) {
            reject(uncertain());
            response.destroy();

            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode !== 202) {
            reject(uncertain());

            return;
          }
          let json: unknown;

          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch (error) {
            reject(error instanceof SyntaxError ? uncertain() : error);

            return;
          }
          const parsed = receiptSchema.safeParse(json);

          if (
            !parsed.success ||
            parsed.data.operationId !== operationId ||
            parsed.data.targetIncarnation !== targetIncarnation ||
            parsed.data.requestDigest !== requestDigest
          ) {
            reject(uncertain());

            return;
          }
          resolve(parsed.data);
        });
      },
    );

    call.on("error", () => reject(uncertain()));
    call.end(body);
  });
}

/** The supervisor reads only host-configured destinations. Command payloads carry identities. */
export function loadStandDispatchTransport(path: string): DispatchStandRestart {
  if (!isAbsolute(path)) throw invalidConfig();
  let targets: z.infer<typeof targetSchema>[];

  try {
    targets = z
      .array(targetSchema)
      .min(1)
      .max(32)
      .parse(JSON.parse(loadFile(path, 65_536).toString("utf8")));
  } catch {
    throw invalidConfig();
  }
  const peers = new Map<string, Target>();

  for (const config of targets) {
    const origin = new URL(config.origin);

    if (
      origin.pathname !== "/" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      peers.has(config.incarnationId)
    )
      throw invalidConfig();
    const credential = loadFile(config.credentialFile, 1026)
      .toString("utf8")
      .replace(/\r?\n$/, "");

    if (!/^[!-~]{1,1024}$/.test(credential)) throw invalidConfig();
    peers.set(config.incarnationId, {
      origin,
      serverName: config.serverName,
      fingerprint: Buffer.from(config.certificateSha256, "hex"),
      ca: loadFile(config.caFile, 65_536),
      cert: loadFile(config.certificateFile, 65_536),
      key: loadFile(config.keyFile, 65_536),
      credential,
    });
  }

  return async (payload) => {
    const target = peers.get(payload.targetIncarnation);

    if (!target)
      throw new SupervisorError(
        "PRECONDITION",
        "The stand is unavailable on this execution host",
      );

    return sendRestart(target, payload);
  };
}
