import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server, type ServerOptions } from "node:https";
import { TLSSocket } from "node:tls";

import { AuthorityClientError } from "./authority-client.ts";
import type {
  RestartEntry,
  RestartIntent,
  RestartJournal,
  ServiceObservation,
} from "./restart-journal.ts";
import { RestartJournalError } from "./restart-journal.ts";
import { createRestartService, type Authorization } from "./restart-service.ts";
import {
  SystemdError,
  type SystemdDriver,
  type SystemdUnit,
} from "./systemd.ts";

type Component = SystemdUnit &
  Readonly<{
    id: string;
    actions: readonly ("inspect" | "logs" | "restart" | "verify")[];
  }>;

export type HelperTarget = Readonly<{
  id: string;
  companyId: string;
  incarnationId: string;
  configRevision: number;
  components: readonly Component[];
}>;

export type StandHelperOptions = Readonly<{
  tls: Pick<ServerOptions, "cert" | "key" | "ca">;
  platformCertificateSha256: string;
  platformCredential: string;
  target: HelperTarget;
  journal: RestartJournal;
  authorize(intent: RestartIntent): Promise<Authorization>;
  authorizeReceipt(intent: RestartIntent): Promise<boolean>;
  manager: Pick<SystemdDriver, "inspect" | "restart">;
}>;

type RestartRequest = Omit<RestartIntent, "resourceKey"> &
  Readonly<{
    componentId: string;
    before: ServiceObservation;
  }>;

class HelperError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, reason: string) {
    super(reason);
    this.status = status;
    this.code = code;
  }
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
const maximumRequestBytes = 65_536;
const receiptPath = /^\/operations\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/;
const requestFields = [
  "operationId",
  "targetIncarnation",
  "componentId",
  "action",
  "requestDigest",
  "ownerEpoch",
  "before",
];

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function authenticate(
  request: IncomingMessage,
  options: StandHelperOptions,
  credentialDigest: Buffer,
): void {
  const socket = request.socket;
  const peer =
    socket instanceof TLSSocket && socket.authorized
      ? socket.getPeerX509Certificate()
      : undefined;
  const headers = request.headersDistinct["x-maister-platform-token"];
  const credential = headers?.length === 1 ? headers[0] : undefined;

  if (
    !peer ||
    peer.fingerprint256.replaceAll(":", "").toLowerCase() !==
      options.platformCertificateSha256 ||
    !credential ||
    !/^[!-~]{1,1024}$/.test(credential) ||
    !timingSafeEqual(sha256(credential), credentialDigest)
  )
    throw new HelperError(
      401,
      "UNAUTHENTICATED",
      "platform_credential_required",
    );
}

function objectValue(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new HelperError(400, "CONFIG", "invalid_request");

  return raw as Record<string, unknown>;
}

function requiredIdentity(value: unknown): string {
  if (typeof value !== "string" || !identifier.test(value))
    throw new HelperError(400, "CONFIG", "invalid_request");

  return value;
}

function readReceiptSelector(request: IncomingMessage): {
  requestDigest: string;
  ownerEpoch: number;
} {
  const digests = request.headersDistinct["x-maister-request-digest"];
  const epochs = request.headersDistinct["x-maister-owner-epoch"];
  const requestDigest = digests?.length === 1 ? digests[0] : undefined;
  const epoch = epochs?.length === 1 ? epochs[0] : undefined;
  const ownerEpoch = Number(epoch);

  if (
    !requestDigest ||
    !digest.test(requestDigest) ||
    !epoch ||
    !/^[1-9][0-9]{0,15}$/.test(epoch) ||
    !Number.isSafeInteger(ownerEpoch)
  )
    throw new HelperError(400, "CONFIG", "invalid_request");

  return { requestDigest, ownerEpoch };
}

async function readRestart(request: IncomingMessage): Promise<RestartRequest> {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    request.headers["content-encoding"]
  )
    throw new HelperError(400, "CONFIG", "invalid_content_type");
  if (Number(request.headers["content-length"]) > maximumRequestBytes)
    throw new HelperError(413, "CONFIG", "request_too_large");
  let size = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    size += buffer.length;
    if (size > maximumRequestBytes)
      throw new HelperError(413, "CONFIG", "request_too_large");
    chunks.push(buffer);
  }
  let raw: unknown;

  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError))
      throw error;
    throw new HelperError(400, "CONFIG", "invalid_request");
  }
  const input = objectValue(raw);
  const before = objectValue(input.before);
  const { invocationId, state } = before;
  const { requestDigest, ownerEpoch } = input;

  if (
    Object.keys(input).length !== requestFields.length ||
    requestFields.some((key) => !Object.hasOwn(input, key)) ||
    Object.keys(before).length !== 2 ||
    input.action !== "restart" ||
    typeof requestDigest !== "string" ||
    !digest.test(requestDigest) ||
    typeof ownerEpoch !== "number" ||
    !Number.isSafeInteger(ownerEpoch) ||
    ownerEpoch < 1 ||
    !(
      invocationId === null ||
      (typeof invocationId === "string" && /^[a-f0-9]{32}$/.test(invocationId))
    ) ||
    !(state === "active" || state === "inactive" || state === "failed") ||
    (state === "active" && invocationId === null)
  )
    throw new HelperError(400, "CONFIG", "invalid_request");

  return {
    operationId: requiredIdentity(input.operationId),
    targetIncarnation: requiredIdentity(input.targetIncarnation),
    componentId: requiredIdentity(input.componentId),
    requestDigest,
    ownerEpoch,
    before: { invocationId, state },
  };
}

function targetReceipt(entry: RestartEntry) {
  const effectState =
    entry.phase === "intent_retained"
      ? "not_dispatched"
      : entry.phase === "effect_started"
        ? "unknown"
        : entry.phase;

  return {
    operationId: entry.operationId,
    targetIncarnation: entry.targetIncarnation,
    requestDigest: entry.requestDigest,
    receiptRevision: entry.revision,
    sequence: entry.sequence,
    effectState,
    permitId: entry.permitId,
    beforeInvocation: entry.before.invocationId,
    afterInvocation: entry.after?.invocationId ?? null,
    observedState:
      entry.after?.state ??
      (entry.phase === "intent_retained" ? entry.before.state : "unknown"),
    capturedAt: entry.capturedAt,
    reason: entry.reason,
  };
}

function json(response: ServerResponse, status: number, value: object): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function handleFailure(response: ServerResponse, error: unknown): void {
  if (error instanceof HelperError) {
    json(response, error.status, { code: error.code, message: error.message });
    return;
  }
  if (
    error instanceof RestartJournalError &&
    error.reason !== "journal_corrupt"
  ) {
    json(response, 409, { code: "CONFLICT", message: error.reason });
    return;
  }
  const message =
    error instanceof AuthorityClientError ||
    error instanceof SystemdError ||
    error instanceof RestartJournalError
      ? error.reason
      : "operation_unavailable";

  console.warn(
    JSON.stringify({
      component: "stand-helper",
      event: "operation_failed",
      reason: message,
      errorType: error instanceof Error ? error.name : typeof error,
    }),
  );
  json(response, 503, { code: "EXECUTOR_UNAVAILABLE", message });
}

/** Ingress accepts only a reviewed target and components; caller data cannot select a unit or a command. */
export function createStandHelper(options: StandHelperOptions): Server {
  const { target } = options;
  const components = new Map(
    target.components.map((component) => [component.id, component]),
  );

  if (
    !options.tls.cert ||
    !options.tls.key ||
    !options.tls.ca ||
    !digest.test(options.platformCertificateSha256) ||
    !/^[!-~]{1,1024}$/.test(options.platformCredential) ||
    !identifier.test(target.id) ||
    !identifier.test(target.companyId) ||
    !identifier.test(target.incarnationId) ||
    !Number.isSafeInteger(target.configRevision) ||
    target.configRevision < 1 ||
    components.size !== target.components.length ||
    components.size === 0 ||
    components.size > 32 ||
    target.components.some((component) => !identifier.test(component.id))
  )
    throw new HelperError(400, "CONFIG", "unsupported_config");
  const credentialDigest = sha256(options.platformCredential);

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    authenticate(request, options, credentialDigest);
    if (request.method === "GET" && request.url === "/identity") {
      json(response, 200, {
        id: target.id,
        owner: { kind: "company", companyId: target.companyId },
        incarnationId: target.incarnationId,
        configRevision: target.configRevision,
        enabled: true,
        componentIds: [...components.keys()],
      });
      return;
    }
    const receiptId =
      request.method === "GET"
        ? request.url?.match(receiptPath)?.[1]
        : undefined;

    if (receiptId) {
      const { requestDigest, ownerEpoch } = readReceiptSelector(request);
      const entry = options.journal.read(receiptId);

      if (!entry || entry.requestDigest !== requestDigest)
        throw new HelperError(404, "PRECONDITION", "receipt_missing");
      if (
        !(await options.authorizeReceipt({
          operationId: receiptId,
          requestDigest,
          ownerEpoch,
          resourceKey: entry.resourceKey,
          targetIncarnation: entry.targetIncarnation,
        }))
      )
        throw new HelperError(403, "PERMISSION", "authority_refused");

      json(response, 200, targetReceipt(entry));
      return;
    }
    if (request.method !== "POST" || request.url !== "/operations")
      throw new HelperError(404, "PRECONDITION", "operation_unavailable");
    const { componentId, before, ...identity } = await readRestart(request);

    if (identity.targetIncarnation !== target.incarnationId)
      throw new HelperError(409, "CONFLICT", "target_identity_mismatch");
    const component = components.get(componentId);

    if (!component)
      throw new HelperError(404, "PRECONDITION", "component_unavailable");
    if (!component.actions.includes("restart"))
      throw new HelperError(403, "PERMISSION", "unsupported_action");
    const resourceKey = sha256(
      JSON.stringify({
        incarnationId: target.incarnationId,
        manager: "systemd",
        scope: component.scope,
        unit: component.unit,
        user: component.user,
      }),
    ).toString("hex");
    const service = createRestartService(options.journal, {
      inspect: () => options.manager.inspect(component),
      authorize: options.authorize,
      restart: () => options.manager.restart(component),
    });

    json(
      response,
      202,
      targetReceipt(
        await service.execute({ ...identity, resourceKey }, before),
      ),
    );
  }

  return createServer(
    {
      ...options.tls,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      requestTimeout: 10_000,
      headersTimeout: 5_000,
    },
    (request, response) => {
      void route(request, response).catch((error: unknown) =>
        handleFailure(response, error),
      );
    },
  );
}
