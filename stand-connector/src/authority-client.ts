import { randomUUID } from "node:crypto";
import { request } from "node:https";

import type { RestartIntent } from "./restart-journal.ts";
import type { Authorization } from "./restart-service.ts";

export type AuthorityConfig = Readonly<{
  origin: string;
  serverName: string;
  ca: Buffer;
  certificate: Buffer;
  key: Buffer;
  credential: string;
}>;
type AuthorityClient = Readonly<{
  authorize(intent: RestartIntent): Promise<Authorization>;
  authorizeReceipt(intent: RestartIntent): Promise<boolean>;
}>;

export class AuthorityClientError extends Error {
  readonly reason:
    "authority_unavailable" | "invalid_permit" | "unsupported_config";

  constructor(reason: AuthorityClientError["reason"]) {
    super(reason);
    this.reason = reason;
  }
}

const authorityResponseLimit = 4096;
const authorityDeadlineMs = 3000;

type AuthorityReply = Readonly<{ status: number; text: string }>;

function readPermit(
  origin: URL,
  config: AuthorityConfig,
  operationId: string,
  body: string,
): Promise<AuthorityReply> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(operationId))
    throw new AuthorityClientError("invalid_permit");
  const path = `/api/stand-operations/${operationId}/authorizations/check`;

  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(authorityDeadlineMs);
    const outgoing = request(
      new URL(path, origin),
      {
        method: "POST",
        ca: config.ca,
        cert: config.certificate,
        key: config.key,
        servername: config.serverName,
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        agent: false,
        signal,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-MAIster-Helper-Token": config.credential,
        },
      },
      (reply) => {
        const chunks: Buffer[] = [];
        let size = 0;

        reply.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > authorityResponseLimit) {
            reject(new AuthorityClientError("invalid_permit"));
            reply.destroy();
          } else {
            chunks.push(chunk);
          }
        });
        reply.on("error", () =>
          reject(new AuthorityClientError("authority_unavailable")),
        );
        reply.on("end", () =>
          resolve({
            status: reply.statusCode ?? 503,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );

    outgoing.on("error", () =>
      reject(new AuthorityClientError("authority_unavailable")),
    );
    outgoing.end(body);
  });
}

function decodePermit(text: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AuthorityClientError("invalid_permit");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new AuthorityClientError("invalid_permit");

  return parsed as Record<string, unknown>;
}

/** A dispatch permit is single-use. Any lost or malformed response requires reconciliation. */
export function createAuthorityClient(
  config: AuthorityConfig,
): AuthorityClient {
  const origin = new URL(config.origin);

  if (
    origin.protocol !== "https:" ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    !/^[A-Za-z0-9.-]{1,253}$/.test(config.serverName) ||
    !/^[!-~]{1,1024}$/.test(config.credential)
  )
    throw new AuthorityClientError("unsupported_config");

  async function authorizePurpose(
    intent: RestartIntent,
    purpose: "dispatch" | "reconcile",
  ): Promise<Authorization> {
    const {
      operationId,
      ownerEpoch,
      requestDigest,
      resourceKey,
      targetIncarnation,
    } = intent;
    const nonce = randomUUID();
    const identity = {
      ownerEpoch,
      requestDigest,
      resourceKey,
      targetIncarnation,
      nonce,
      purpose,
    };
    const reply = await readPermit(
      origin,
      config,
      operationId,
      JSON.stringify(identity),
    );

    if (reply.status === 401 || reply.status === 403 || reply.status === 409)
      return { decision: "refused" };
    if (reply.status !== 200)
      throw new AuthorityClientError("authority_unavailable");
    const permit = decodePermit(reply.text);
    const { permitId, expiresAt } = permit;
    const now = Date.now();
    const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;

    if (
      Object.keys(permit).length !== 10 ||
      permit.allowed !== true ||
      permit.operationId !== operationId ||
      Object.entries(identity).some(
        ([field, expected]) => permit[field] !== expected,
      ) ||
      typeof permitId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(permitId) ||
      typeof expiresAt !== "string" ||
      !(expiry > now && expiry <= now + 5000)
    )
      throw new AuthorityClientError("invalid_permit");

    return { decision: "allowed", permit: { permitId, expiresAt } };
  }

  return {
    authorize: (intent) => authorizePurpose(intent, "dispatch"),
    authorizeReceipt: async (intent) =>
      (await authorizePurpose(intent, "reconcile")).decision === "allowed",
  };
}
