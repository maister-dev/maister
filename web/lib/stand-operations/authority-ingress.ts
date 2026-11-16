import "server-only";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server, ServerOptions } from "node:https";
import type { AddressInfo } from "node:net";

import { createServer } from "node:https";
import { once } from "node:events";
import { TLSSocket } from "node:tls";

import pino from "pino";

import { STAND_OPERATION_BODY_MAX_BYTES } from "./operation-types";

import { httpStatusForAuthz } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";

const log = pino({ name: "stand-authority-ingress" });
const authorityPath =
  /^\/api\/stand-operations\/([A-Za-z0-9._:-]{1,128})\/authorizations\/check$/;

type AuthorityPeerRequest = Readonly<{
  operationId: string;
  peerFingerprint: string;
  helperToken: string;
  body: unknown;
}>;
type IngressResponse = Readonly<{ status: number; body: unknown }>;
type AuthorizePeer = (
  request: AuthorityPeerRequest,
) => Promise<IngressResponse>;

async function dispatchAuthority(
  request: IncomingMessage,
  authorize: AuthorizePeer,
): Promise<IngressResponse> {
  const path = request.url?.match(authorityPath);

  if (request.method !== "POST" || !path?.[1])
    return {
      status: 404,
      body: { code: "PRECONDITION", message: "Authority endpoint unavailable" },
    };
  const socket = request.socket;
  const peer =
    socket instanceof TLSSocket && socket.authorized
      ? socket.getPeerX509Certificate()
      : undefined;
  const helperToken = request.headersDistinct["x-maister-helper-token"];

  if (
    !peer ||
    helperToken?.length !== 1 ||
    !helperToken[0] ||
    helperToken[0].length > 1024
  )
    throw new MaisterError(
      "UNAUTHENTICATED",
      "A verified helper credential is required",
    );
  const contentType = request.headers["content-type"];
  const webRequest = new Request("https://authority.internal/", {
    method: "POST",
    headers: contentType ? { "content-type": contentType } : undefined,
    body: requestBody(request),
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  return authorize({
    operationId: path[1],
    peerFingerprint: peer.fingerprint256,
    helperToken: helperToken[0],
    body: await readBoundedJson(webRequest, STAND_OPERATION_BODY_MAX_BYTES),
  });
}

function requestBody(request: IncomingMessage): ReadableStream<Uint8Array> {
  const iterator: AsyncIterator<Uint8Array> = request.iterator({
    destroyOnReturn: false,
  });

  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();

      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function ingressFailure(error: unknown): IngressResponse {
  if (isMaisterError(error)) {
    const reason = error.details?.reason;
    const status =
      httpStatusForAuthz(error.code) ??
      (error.code === "CONFIG"
        ? reason === "json_body_too_large"
          ? 413
          : 400
        : error.code === "CONFLICT" || error.code === "PRECONDITION"
          ? 409
          : error.code === "EXECUTOR_UNAVAILABLE"
            ? 503
            : null);

    if (status !== null)
      return {
        status,
        body: {
          code: error.code,
          message: error.message,
          ...(typeof reason === "string" ? { details: { reason } } : {}),
        },
      };
  }
  log.error(
    { errorType: error instanceof Error ? error.name : typeof error },
    "stand authority request failed",
  );

  return {
    status: 503,
    body: {
      code: "EXECUTOR_UNAVAILABLE",
      message: "Stand authority unavailable",
    },
  };
}

function sendAuthorityResponse(
  response: ServerResponse,
  result: IngressResponse,
): void {
  response.writeHead(result.status, {
    "cache-control": "private, no-store",
    "content-type": "application/json",
    connection: "close",
  });
  response.end(JSON.stringify(result.body));
}

/** This listener has no browser, proxy-header or unauthenticated HTTP entry point. */
function createStandAuthorityIngress(
  tls: Required<Pick<ServerOptions, "ca" | "cert" | "key">>,
  authorize: AuthorizePeer,
): Server {
  return createServer(
    {
      ...tls,
      minVersion: "TLSv1.2",
      requestCert: true,
      rejectUnauthorized: true,
      headersTimeout: 3_000,
      requestTimeout: 3_000,
      connectionsCheckingInterval: 500,
      maxHeaderSize: 8_192,
    },
    (request, response) => {
      void dispatchAuthority(request, authorize)
        .catch(ingressFailure)
        .then((result) => sendAuthorityResponse(response, result));
    },
  );
}

type StandAuthorityIngress = Readonly<{
  address: AddressInfo;
  close: () => Promise<void>;
}>;

export async function startStandAuthorityIngress(
  tls: Required<Pick<ServerOptions, "ca" | "cert" | "key">>,
  binding: Readonly<{ port: number; host: string }>,
  authorize: AuthorizePeer,
): Promise<StandAuthorityIngress> {
  const server = createStandAuthorityIngress(tls, authorize);
  const ready = once(server, "listening");

  server.listen(binding);
  await ready;
  const address = server.address();

  if (!address || typeof address === "string")
    throw new MaisterError("CONFIG", "Stand authority requires a TCP listener");

  return {
    address,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
