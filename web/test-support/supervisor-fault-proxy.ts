import type { Socket } from "node:net";

import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { parseCommandOutputManifestV2 } from "../../runtime/command-evidence";
import { safeDownloadHeaders } from "../../runtime/safe-download";

import { invocationFromEnvironment, logInvocation } from "./process-invocation";

const MAX_BODY = 8 * 1024 * 1024;
const MAX_FRAME = 2 * 1024 * 1024;
const COMMAND_OUTPUT_DISPOSITION = safeDownloadHeaders({
  fileName: "command-output.v2.json",
  mediaClass: "opaque",
})["content-disposition"];

function endToEndHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const hopHeaders = new Set([
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...(headers.connection ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase()),
  ]);

  // Each HTTP hop supplies its own framing and socket lifetime.
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !hopHeaders.has(name.toLowerCase()),
    ),
  );
}

export class FaultBarrierError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FaultBarrierError";
  }
}

export type FaultSelector = {
  caseId: string;
  method: string;
  path: RegExp;
  commandId?: string;
  eventType?: string;
  commandPhases?: readonly string[];
  objectId?: string;
  sequence?: string;
  assignmentEpoch?: number;
  streamId?: string;
  responseSchema?: "maister.command-output.v2";
  applicationClaimToken?: (
    witness: Readonly<FaultWitness>,
  ) => Promise<string | null>;
};
export type FaultAction =
  | "hold-request"
  | "hold-requests"
  | "hold-response"
  | "hold-responses"
  | "drop-responses"
  | "block-receipts"
  | "hold-events"
  | "cut-frame"
  | "duplicate-frame";
export type FaultWitness = {
  method: string;
  path: string;
  commandId: string | null;
  assignmentEpoch: number | null;
  status: number | null;
  sequence: string | null;
  eventType: string | null;
  commandPhase?: string;
  lastEventId: string | null;
  streamId: string | null;
  runId?: string;
  hostSessionId?: string;
  requestSha256?: string;
  claimToken?: string;
  contentType?: string;
  contentDisposition?: string;
};
export type ResponseCloseWitness = {
  commandId: string | null;
  headersSent: boolean;
  writableFinished: boolean;
};
type Pending = { release(): void; cut(): void };
export type FaultBarrier = {
  readonly selector: FaultSelector;
  readonly action: FaultAction;
  readonly observations: readonly FaultWitness[];
  readonly responseClosures: readonly ResponseCloseWitness[];
  awaitReached(timeoutMs?: number): Promise<FaultWitness>;
  release(): void;
  cut(): void;
  ownedProcessKilled(): void;
};
type Rule = FaultBarrier & {
  active: boolean;
  disposed: boolean;
  pending: Set<Pending>;
  retainedBytes: number;
  abortedBeforeDisposition: boolean;
  reach(witness: FaultWitness): void;
  recordResponseClose(witness: ResponseCloseWitness): void;
  abort(error: Error): void;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function recordFaultEvent(
  caseName: string,
  event: string,
  fields: Record<string, string | number | boolean | null>,
): void {
  const invocation = invocationFromEnvironment();

  if (!invocation)
    throw new FaultBarrierError("proxy requires an invocation identity");
  logInvocation(invocation, event, {
    role: "fault-proxy",
    caseName,
    pid: process.pid,
    pgid: 0,
    rootRole: "test-support",
    bootId: invocation.id,
    ...fields,
  });
}

function makeRule(selector: FaultSelector, action: FaultAction): Rule {
  const observations: FaultWitness[] = [];
  const responseClosures: ResponseCloseWitness[] = [];
  const waiting = new Set<{
    resolve(value: FaultWitness): void;
    reject(error: Error): void;
  }>();
  const pending = new Set<Pending>();

  function dispose(
    disposition: "release" | "cut" | "owned-process-killed",
  ): void {
    if (rule.disposed || observations.length === 0)
      throw new FaultBarrierError(
        `${selector.caseId}: cannot ${disposition} an unreached/disposed barrier`,
      );
    if (rule.abortedBeforeDisposition && disposition !== "owned-process-killed")
      throw new FaultBarrierError(
        `${selector.caseId}: client aborted before ${disposition}`,
      );
    rule.disposed = true;
    rule.active = false;
    recordFaultEvent(selector.caseId, "barrier-disposition", {
      action,
      disposition,
      matches: observations.length,
    });
    for (const item of pending) {
      if (disposition === "release") item.release();
      else item.cut();
    }
    pending.clear();
  }
  const rule: Rule = {
    selector,
    action,
    observations,
    responseClosures,
    pending,
    retainedBytes: 0,
    abortedBeforeDisposition: false,
    active: true,
    disposed: false,
    recordResponseClose(witness) {
      responseClosures.push(witness);
      recordFaultEvent(selector.caseId, "downstream-response-closed", witness);
    },
    reach(witness) {
      if (
        observations.length > 0 &&
        ["hold-request", "hold-response", "cut-frame"].includes(action)
      )
        throw new FaultBarrierError(
          `${selector.caseId}: single-shot barrier matched twice`,
        );
      if (observations.length >= 1000)
        throw new FaultBarrierError(
          `${selector.caseId}: observation limit exceeded`,
        );
      observations.push(witness);
      recordFaultEvent(selector.caseId, "barrier-reached", {
        action,
        ...witness,
      });
      for (const waiter of waiting) waiter.resolve(witness);
      waiting.clear();
    },
    abort(error) {
      rule.active = false;
      for (const waiter of waiting) waiter.reject(error);
      waiting.clear();
      for (const item of pending) item.cut();
      pending.clear();
    },
    awaitReached(timeoutMs = 60_000) {
      if (observations[0]) return Promise.resolve(observations[0]);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(waiter);
          reject(
            new FaultBarrierError(
              `${selector.caseId}: ${action} was never reached`,
            ),
          );
        }, timeoutMs);
        const waiter = {
          resolve(value: FaultWitness) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error: Error) {
            clearTimeout(timer);
            reject(error);
          },
        };

        waiting.add(waiter);
      });
    },
    release() {
      dispose("release");
    },
    cut() {
      dispose("cut");
    },
    ownedProcessKilled() {
      dispose("owned-process-killed");
    },
  };

  return rule;
}

async function bytes(
  message: IncomingMessage,
  maximum: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;

  for await (const chunk of message) {
    const part = Buffer.from(chunk as Uint8Array);

    length += part.length;
    if (length > maximum)
      throw new FaultBarrierError(`proxy body exceeds ${maximum} bytes`);
    chunks.push(part);
  }

  return Buffer.concat(chunks.map((chunk) => Uint8Array.from(chunk)));
}

function write(response: ServerResponse, data: Buffer): Promise<void> {
  if (response.destroyed) return Promise.resolve();

  return new Promise((resolve, reject) => {
    response.write(data, (error) => {
      if (!error) {
        resolve();

        return;
      }
      const code = (error as NodeJS.ErrnoException).code;

      if (
        code === "EPIPE" ||
        code === "ECONNRESET" ||
        code === "ECANCELED" ||
        code === "ERR_STREAM_DESTROYED"
      ) {
        recordFaultEvent("proxy", "downstream-disconnected", {
          method: response.req.method ?? "GET",
          path: response.req.url ?? "/",
          code,
          error: error.message,
        });
        response.destroy();
        resolve();

        return;
      }
      reject(error);
    });
  });
}

export type SupervisorFaultProxy = {
  url: string;
  arm(selector: FaultSelector, action: FaultAction): FaultBarrier;
  readonly traffic: readonly FaultWitness[];
  assertDrained(): void;
  close(): Promise<void>;
};

/** Test-only HTTP forwarding; barriers retain original wire bytes and never invent host evidence. */
export async function startSupervisorFaultProxy(
  upstreamUrl: string,
): Promise<SupervisorFaultProxy> {
  const upstreamBase = new URL(upstreamUrl);

  if (
    upstreamBase.protocol !== "http:" ||
    upstreamBase.hostname !== "127.0.0.1"
  )
    throw new FaultBarrierError(
      "fault proxy requires an owned loopback HTTP supervisor",
    );
  const rules: Rule[] = [];
  const sockets = new Set<Socket>();
  const failures: Error[] = [];
  const traffic: FaultWitness[] = [];

  function matching(
    witness: FaultWitness,
    actions: readonly FaultAction[],
    objectId?: string,
    responseSchema?: FaultSelector["responseSchema"],
  ): Rule | undefined {
    return rules.find(
      (rule) =>
        rule.active &&
        actions.includes(rule.action) &&
        rule.selector.method === witness.method &&
        rule.selector.path.test(witness.path) &&
        (rule.selector.assignmentEpoch === undefined ||
          rule.selector.assignmentEpoch === witness.assignmentEpoch) &&
        (rule.selector.streamId === undefined ||
          rule.selector.streamId === witness.streamId) &&
        (!rule.selector.commandId ||
          rule.selector.commandId === witness.commandId) &&
        (!rule.selector.eventType ||
          rule.selector.eventType === witness.eventType) &&
        (!rule.selector.commandPhases ||
          (witness.commandPhase !== undefined &&
            rule.selector.commandPhases.includes(witness.commandPhase))) &&
        (!rule.selector.sequence ||
          rule.selector.sequence === witness.sequence) &&
        (!rule.selector.objectId || rule.selector.objectId === objectId) &&
        (!rule.selector.responseSchema ||
          rule.selector.responseSchema === responseSchema),
    );
  }
  function fail(error: unknown, downstream: ServerResponse): void {
    const failure =
      error instanceof Error ? error : new FaultBarrierError(String(error));

    failures.push(failure);
    recordFaultEvent("proxy", "proxy-failure", {
      outcome: "failed",
      error: failure.message,
    });
    downstream.destroy();
  }
  async function serve(
    incoming: IncomingMessage,
    downstream: ServerResponse,
  ): Promise<void> {
    const method = incoming.method ?? "GET";
    const pathname = incoming.url ?? "/";
    const body = await bytes(incoming, MAX_BODY);
    const decoded =
      incoming.headers["content-type"]?.includes("application/json") &&
      body.length > 0
        ? record(JSON.parse(body.toString("utf8")))
        : {};
    const envelope = record(decoded.envelope ?? decoded);
    const command = record(envelope.command);
    const fence = record(envelope.fence);
    const witness: FaultWitness = {
      method,
      path: pathname,
      commandId:
        typeof command.id === "string"
          ? command.id
          : (pathname.match(/^\/commands\/([^/?]+)$/)?.[1] ?? null),
      assignmentEpoch:
        typeof fence.assignmentEpoch === "number"
          ? fence.assignmentEpoch
          : null,
      status: null,
      sequence: null,
      eventType: null,
      streamId: null,
      lastEventId:
        typeof incoming.headers["last-event-id"] === "string"
          ? incoming.headers["last-event-id"]
          : null,
    };

    if (traffic.length === 10_000)
      throw new FaultBarrierError("proxy traffic limit exceeded");
    traffic.push(witness);
    const objectId = pathname.match(/^\/runtime-objects\/([^/?]+)/)?.[1];
    const requestRule = matching(
      witness,
      ["hold-request", "hold-requests", "block-receipts"],
      objectId,
    );

    if (requestRule) {
      requestRule.reach(witness);
      await new Promise<void>((resolve) => {
        const pending = {
          release: resolve,
          cut() {
            downstream.destroy();
            resolve();
          },
        };

        requestRule.pending.add(pending);
        downstream.once("close", () => {
          requestRule.pending.delete(pending);
          // Persistent receipt blocking deliberately outlasts client retry deadlines.
          if (!requestRule.disposed && requestRule.action !== "block-receipts")
            requestRule.abortedBeforeDisposition = true;
          resolve();
        });
      });
      if (downstream.destroyed) return;
    }
    const upstream = request(new URL(pathname, upstreamBase), {
      method,
      headers: {
        ...endToEndHeaders(incoming.headers),
        host: upstreamBase.host,
      },
    });

    downstream.once("close", () => upstream.destroy());
    upstream.once("error", (error) => {
      if (!downstream.destroyed) {
        recordFaultEvent("proxy", "upstream-reset", {
          ...witness,
          error: error.message,
        });
        downstream.destroy();
      }
    });
    upstream.once("response", (response) => {
      const received = { ...witness, status: response.statusCode ?? 502 };

      response.once("close", () =>
        recordFaultEvent("proxy", "upstream-response-closed", {
          method,
          path: pathname,
          complete: response.complete,
        }),
      );
      const forward = async (): Promise<void> => {
        if (pathname === "/runtime-events" && response.statusCode === 200) {
          downstream.writeHead(200, endToEndHeaders(response.headers));
          let remainder = Buffer.alloc(0);

          for await (const chunk of response) {
            remainder = Buffer.concat([
              Uint8Array.from(remainder),
              Uint8Array.from(chunk as Uint8Array),
            ]);
            if (remainder.length > MAX_FRAME)
              throw new FaultBarrierError("SSE frame exceeds proxy limit");
            let boundary: number;

            while ((boundary = remainder.indexOf("\n\n")) !== -1) {
              const frame = remainder.subarray(0, boundary + 2);

              remainder = remainder.subarray(boundary + 2);
              const frameText = frame.toString("utf8");
              const data = frameText
                .split("\n")
                .filter((line) => line.startsWith("data: "))
                .map((line) => line.slice(6))
                .join("\n");
              const event = data ? record(JSON.parse(data)) : {};
              const payload = record(event.payload);
              const frameWitness: FaultWitness = {
                ...received,
                sequence: frameText.match(/^id: (.+)$/m)?.[1] ?? null,
                assignmentEpoch:
                  typeof event.assignmentEpoch === "number"
                    ? event.assignmentEpoch
                    : null,
                streamId:
                  typeof event.streamId === "string" ? event.streamId : null,
                eventType:
                  typeof event.eventType === "string" ? event.eventType : null,
                commandPhase:
                  typeof payload.phase === "string" ? payload.phase : undefined,
                commandId:
                  typeof payload.commandId === "string"
                    ? payload.commandId
                    : null,
              };
              const rule = matching(
                frameWitness,
                ["hold-events", "cut-frame", "duplicate-frame"],
                typeof payload.objectId === "string"
                  ? payload.objectId
                  : undefined,
              );

              if (!rule) {
                await write(downstream, frame);
                continue;
              }
              rule.reach(frameWitness);
              if (rule.action === "duplicate-frame") {
                await write(downstream, frame);
                await write(downstream, frame);
                rule.release();
                continue;
              }
              if (rule.action === "hold-events") {
                rule.retainedBytes += frame.length;
                if (rule.retainedBytes > MAX_BODY)
                  throw new FaultBarrierError(
                    `${rule.selector.caseId}: held event bytes exceed limit`,
                  );
                const retained = Buffer.from(frame);
                const forget = (): void => {
                  if (rule.pending.delete(pending))
                    rule.retainedBytes -= retained.length;
                  downstream.removeListener("close", forget);
                };
                const pending = {
                  release() {
                    forget();
                    void write(downstream, retained).catch((error: unknown) =>
                      fail(error, downstream),
                    );
                  },
                  cut() {
                    forget();
                    downstream.destroy();
                    upstream.destroy();
                  },
                };

                rule.pending.add(pending);
                downstream.once("close", forget);
                // Only selected command frames are held. Other commands may arrive
                // beyond the gap; the production contiguous cursor must stay behind it.
                continue;
              }
              if (rule.action === "cut-frame")
                await write(
                  downstream,
                  frame.subarray(0, Math.max(1, frame.length - 3)),
                );
              await new Promise<void>((resolve) => {
                const pending = {
                  release: resolve,
                  cut() {
                    downstream.destroy();
                    upstream.destroy();
                    resolve();
                  },
                };

                rule.pending.add(pending);
                downstream.once("close", () => {
                  rule.pending.delete(pending);
                  if (!rule.disposed && rule.action !== "hold-events")
                    rule.abortedBeforeDisposition = true;
                  resolve();
                });
              });
              if (downstream.destroyed) return;
              await write(
                downstream,
                rule.action === "cut-frame"
                  ? frame.subarray(Math.max(1, frame.length - 3))
                  : frame,
              );
            }
          }
          if (!downstream.destroyed) downstream.end();

          return;
        }
        let responseBody: Buffer | undefined;
        let responseWitness: FaultWitness = received;
        let responseSchema: FaultSelector["responseSchema"];

        if (
          rules.some(
            (candidate) =>
              candidate.active &&
              candidate.selector.responseSchema ===
                "maister.command-output.v2" &&
              candidate.selector.method === method &&
              candidate.selector.path.test(pathname),
          ) &&
          response.statusCode === 200 &&
          response.headers["content-disposition"] === COMMAND_OUTPUT_DISPOSITION
        ) {
          responseBody = await bytes(response, MAX_BODY);
          const manifest = parseCommandOutputManifestV2(
            JSON.parse(responseBody.toString("utf8")) as unknown,
          );

          responseSchema = manifest.schema;
          responseWitness = {
            ...received,
            commandId: manifest.commandId,
            runId: manifest.runId,
            hostSessionId: manifest.hostSessionId,
            requestSha256: manifest.requestSha256,
            assignmentEpoch: manifest.assignmentEpoch,
            streamId: manifest.streamId,
            contentType: String(response.headers["content-type"]),
            contentDisposition: String(response.headers["content-disposition"]),
          };
        }
        let selectedRule = matching(
          responseWitness,
          ["hold-response", "hold-responses", "drop-responses"],
          objectId,
          responseSchema,
        );

        if (selectedRule?.selector.applicationClaimToken) {
          const claimToken =
            await selectedRule.selector.applicationClaimToken(responseWitness);

          if (claimToken === null) {
            recordFaultEvent(
              selectedRule.selector.caseId,
              "preclaim-response-forwarded",
              responseWitness,
            );
            selectedRule = undefined;
          } else {
            if (claimToken.length === 0)
              throw new FaultBarrierError(
                "application claim selector returned an empty token",
              );
            responseWitness = { ...responseWitness, claimToken };
          }
        }
        const rule = selectedRule;

        if (!rule) {
          downstream.writeHead(
            received.status,
            endToEndHeaders(response.headers),
          );
          if (responseBody) {
            downstream.end(responseBody);

            return;
          }
          response.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "ECONNRESET") {
              recordFaultEvent("proxy", "upstream-reset", {
                ...witness,
                error: error.message,
              });
              downstream.destroy();
            } else fail(error, downstream);
          });
          response.pipe(downstream);

          return;
        }
        responseBody ??= await bytes(response, MAX_BODY);

        downstream.once("close", () => {
          rule.recordResponseClose({
            commandId: responseWitness.commandId,
            headersSent: downstream.headersSent,
            writableFinished: downstream.writableFinished,
          });
        });
        rule.reach(responseWitness);
        if (rule.action === "drop-responses") {
          downstream.destroy();

          return;
        }
        rule.retainedBytes += responseBody.length;
        if (rule.retainedBytes > MAX_BODY)
          throw new FaultBarrierError(
            `${rule.selector.caseId}: retained ACK bytes exceed limit`,
          );
        await new Promise<void>((resolve) => {
          const pending = {
            release: resolve,
            cut() {
              downstream.destroy();
              resolve();
            },
          };

          rule.pending.add(pending);
          downstream.once("close", () => {
            rule.pending.delete(pending);
            if (!rule.disposed && rule.action !== "hold-responses")
              rule.abortedBeforeDisposition = true;
            resolve();
          });
        });
        rule.retainedBytes -= responseBody.length;
        if (downstream.destroyed) return;
        downstream.writeHead(
          received.status,
          endToEndHeaders(response.headers),
        );
        downstream.end(responseBody);
      };

      void forward().catch((error: unknown) => {
        if (
          error instanceof Error &&
          (error as NodeJS.ErrnoException).code === "ECONNRESET"
        ) {
          recordFaultEvent("proxy", "upstream-reset", {
            ...witness,
            error: error.message,
          });
          downstream.destroy();
        } else fail(error, downstream);
      });
    });
    upstream.end(body);
  }
  const server = createServer((incoming, response) => {
    void serve(incoming, response).catch((error: unknown) => {
      if (
        incoming.aborted &&
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ECONNRESET"
      ) {
        recordFaultEvent("proxy", "downstream-request-aborted", {
          method: incoming.method ?? "GET",
          path: incoming.url ?? "/",
          error: error.message,
        });
        response.destroy();

        return;
      }
      fail(error, response);
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  if (!address || typeof address === "string")
    throw new FaultBarrierError("proxy did not bind TCP");
  function assertDrained(): void {
    const unresolved = rules
      .filter((rule) => !rule.disposed)
      .map(
        (rule) =>
          `${rule.selector.caseId}:${rule.action}:${rule.observations.length ? "unreleased" : "unreached"}`,
      );

    if (unresolved.length || failures.length)
      throw new AggregateError(
        [...failures, ...unresolved.map((name) => new FaultBarrierError(name))],
        "fault proxy did not drain",
      );
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    traffic,
    arm(selector, action) {
      if (selector.path.global || selector.path.sticky)
        throw new FaultBarrierError("stateful route patterns are forbidden");
      if (
        selector.applicationClaimToken &&
        selector.responseSchema !== "maister.command-output.v2"
      )
        throw new FaultBarrierError(
          "application claim selector requires a command-output manifest response",
        );
      const rule = makeRule(selector, action);

      rules.push(rule);

      return rule;
    },
    assertDrained,
    async close() {
      let failure: unknown;

      try {
        assertDrained();
      } catch (error) {
        failure = error;
      }
      for (const rule of rules)
        rule.abort(new FaultBarrierError("fault proxy closed"));
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (failure) throw failure;
    },
  };
}
