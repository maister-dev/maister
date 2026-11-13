import type {
  DispatchStandRestart,
  ObserveStandOperation,
  ReadStandLogs,
  ReadStandReceipt,
  StandDispatchPayload,
  StandLogsSelector,
  StandObservationSelector,
  StandReceiptSelector,
  StandVerifySelector,
  VerifyStandOperation,
} from "./contracts";
import type { Logger } from "pino";

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
const observationSchema = z
  .object({
    operationId: z.uuid(),
    targetIncarnation: z.uuid(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    resourceKey: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().positive(),
    invocationId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    state: z.enum(["active", "inactive", "failed", "unknown"]),
    capturedAt: z.iso.datetime(),
  })
  .strict();
const verificationSchema = z
  .object({
    id: z.uuid(),
    operationId: z.uuid(),
    targetIncarnation: z.uuid(),
    nonce: z.uuid(),
    state: z.enum(["healthy", "unhealthy", "inconclusive"]),
    issuedAt: z.iso.datetime(),
    observedAt: z.iso.datetime(),
    targetSequence: z.number().int().positive(),
    evidenceIds: z.array(z.string()).max(16),
    reason: z
      .enum(["verification_unhealthy", "verification_inconclusive"])
      .nullable(),
  })
  .strict();
const logsSchema = z
  .object({
    operationId: z.uuid(),
    targetIncarnation: z.uuid(),
    text: z.string().max(262144),
    truncated: z.boolean(),
    sanitized: z.literal(true),
    capturedAt: z.iso.datetime(),
  })
  .strict();

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
    predecessorId,
  } = payload;
  const body = JSON.stringify({
    operationId,
    targetIncarnation,
    componentId,
    action,
    requestDigest,
    ownerEpoch,
    before,
    ...(predecessorId ? { predecessorId } : {}),
  });

  return requestReceipt(target, payload, {
    method: "POST",
    path: "/operations",
    expectedStatus: 202,
    timeoutMs: 53_000,
    body,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }).then((receipt) => {
    if (!receipt) throw unavailable();

    return receipt;
  });
}

type WireCall = Readonly<{
  method: "GET" | "POST";
  path: string;
  expectedStatus: number;
  timeoutMs: number;
  maxResponseBytes?: number;
  body?: string;
  headers: Record<string, string | number>;
}>;

function unavailable(): SupervisorError {
  return new SupervisorError(
    "EXECUTOR_UNAVAILABLE",
    "The stand operation outcome requires reconciliation",
  );
}

function requestReceipt(
  target: Target,
  identity: StandReceiptSelector,
  spec: WireCall,
): Promise<Record<string, unknown> | null> {
  return requestTarget(target, identity, spec, receiptSchema);
}

function requestTarget<
  T extends {
    operationId: string;
    targetIncarnation: string;
    requestDigest?: string;
  },
>(
  target: Target,
  identity: StandReceiptSelector,
  spec: WireCall,
  schema: z.ZodType<T>,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const call = request(
      new URL(spec.path, target.origin),
      {
        method: spec.method,
        ca: target.ca,
        cert: target.cert,
        key: target.key,
        servername: target.serverName,
        checkServerIdentity: (hostname, certificate) =>
          checkTargetCertificate(target, hostname, certificate),
        minVersion: "TLSv1.2",
        agent: false,
        signal: AbortSignal.timeout(spec.timeoutMs),
        headers: {
          ...spec.headers,
          "X-Maister-Platform-Token": target.credential,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;

        response.on("error", () => reject(unavailable()));
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > (spec.maxResponseBytes ?? 4096)) {
            reject(unavailable());
            response.destroy();

            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (spec.method === "GET" && response.statusCode === 404) {
            resolve(null);

            return;
          }
          if (
            spec.method === "GET" &&
            (response.statusCode === 401 || response.statusCode === 403)
          ) {
            reject(
              new SupervisorError(
                "PRECONDITION",
                "The stand receipt authority was refused",
              ),
            );

            return;
          }
          if (response.statusCode !== spec.expectedStatus) {
            reject(unavailable());

            return;
          }
          let json: unknown;

          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch (error) {
            reject(error instanceof SyntaxError ? unavailable() : error);

            return;
          }
          const parsed = schema.safeParse(json);

          if (
            !parsed.success ||
            parsed.data.operationId !== identity.operationId ||
            parsed.data.targetIncarnation !== identity.targetIncarnation ||
            (parsed.data.requestDigest !== undefined &&
              parsed.data.requestDigest !== identity.requestDigest)
          ) {
            reject(unavailable());

            return;
          }
          resolve(parsed.data);
        });
      },
    );

    call.on("error", () => reject(unavailable()));
    call.end(spec.body);
  });
}

async function logsForStand(
  target: Target,
  selector: StandLogsSelector,
): Promise<Record<string, unknown>> {
  const logs = await requestTarget(
    target,
    selector,
    {
      method: "GET",
      path: `/operations/${selector.operationId}/logs`,
      expectedStatus: 200,
      timeoutMs: 5000,
      maxResponseBytes: 524_288,
      headers: {
        "X-Maister-Request-Digest": selector.requestDigest,
        "X-Maister-Owner-Epoch": selector.ownerEpoch,
        "X-Maister-Component-Id": selector.componentId,
      },
    },
    logsSchema,
  );

  if (!logs || Buffer.byteLength(logs.text) > 262_144) throw unavailable();

  return logs;
}

async function verifyStand(
  target: Target,
  selector: StandVerifySelector,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ ...selector, action: "verify" });
  const result = await requestTarget(
    target,
    selector,
    {
      method: "POST",
      path: `/operations/${selector.operationId}/verification`,
      expectedStatus: 200,
      timeoutMs: 5000,
      body,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    verificationSchema,
  );

  if (
    !result ||
    result.nonce !== selector.verificationNonce ||
    result.issuedAt !== selector.issuedAt
  )
    throw unavailable();

  return result;
}

async function observeStand(
  target: Target,
  selector: StandObservationSelector,
): Promise<Record<string, unknown>> {
  const {
    operationId,
    targetIncarnation,
    componentId,
    requestDigest,
    ownerEpoch,
    resourceKey,
  } = selector;
  const body = JSON.stringify({
    operationId,
    targetIncarnation,
    componentId,
    requestDigest,
    ownerEpoch,
    action: "inspect",
  });
  const observed = await requestTarget(
    target,
    selector,
    {
      method: "POST",
      path: `/operations/${operationId}/observations`,
      expectedStatus: 200,
      timeoutMs: 5000,
      body,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    observationSchema,
  );

  if (!observed || observed.resourceKey !== resourceKey) throw unavailable();

  return observed;
}

async function readReceipt(
  target: Target,
  selector: StandReceiptSelector,
  logger: Pick<Logger, "warn">,
): Promise<Record<string, unknown> | null> {
  for (const backoffMs of [200, 500]) {
    try {
      return await requestOriginalReceipt(target, selector);
    } catch (error) {
      if (
        !(error instanceof SupervisorError) ||
        error.code !== "EXECUTOR_UNAVAILABLE"
      )
        throw error;
      logger.warn(
        { operationId: selector.operationId, backoffMs, code: error.code },
        "stand receipt read will retry",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  return requestOriginalReceipt(target, selector);
}

function requestOriginalReceipt(
  target: Target,
  selector: StandReceiptSelector,
): Promise<Record<string, unknown> | null> {
  return requestReceipt(target, selector, {
    method: "GET",
    path: `/operations/${selector.operationId}`,
    expectedStatus: 200,
    timeoutMs: 5000,
    headers: {
      "X-Maister-Request-Digest": selector.requestDigest,
      "X-Maister-Owner-Epoch": selector.ownerEpoch,
    },
  });
}

/** The supervisor reads only host-configured destinations. Command payloads carry identities. */
export function loadStandTransport(
  path: string,
  logger: Pick<Logger, "warn">,
): {
  dispatch: DispatchStandRestart;
  readReceipt: ReadStandReceipt;
  observe: ObserveStandOperation;
  verify: VerifyStandOperation;
  logs: ReadStandLogs;
} {
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

  function targetFor(incarnationId: string): Target {
    const target = peers.get(incarnationId);

    if (!target)
      throw new SupervisorError(
        "PRECONDITION",
        "The stand is unavailable on this execution host",
      );

    return target;
  }

  return {
    dispatch: (payload) =>
      sendRestart(targetFor(payload.targetIncarnation), payload),
    readReceipt: (selector) =>
      readReceipt(targetFor(selector.targetIncarnation), selector, logger),
    observe: (selector) =>
      observeStand(targetFor(selector.targetIncarnation), selector),
    verify: (selector) =>
      verifyStand(targetFor(selector.targetIncarnation), selector),
    logs: (selector) =>
      logsForStand(targetFor(selector.targetIncarnation), selector),
  };
}
