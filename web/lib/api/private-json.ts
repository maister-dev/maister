import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { httpStatusForAuthz } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";

const log = pino({
  name: "api:private-json",
  level: process.env.LOG_LEVEL ?? "info",
});

const notFoundReasons = new Set([
  "knowledge_reference_unavailable",
  "assignment_reference_unavailable",
  "assignment_context_unavailable",
  "assignment_delivery_reference_unavailable",
  "company_binding_reference_unavailable",
  "company_grant_unavailable",
  "stand_target_unavailable",
  "stand_operation_unavailable",
]);
const tooLargeReasons = new Set([
  "knowledge_body_too_large",
  "json_body_too_large",
]);
const maximumBodyBytes = 262144;

/** Responses that carry per-principal data: never cached, varied by credential. */
export function privateJson(value: unknown, status = 200): NextResponse {
  return NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      Vary: "Cookie, Authorization",
    },
  });
}

export function privateErrorResponse(
  error: unknown,
  route: string,
): NextResponse {
  if (isMaisterError(error)) {
    const reason = error.details?.reason;

    if (error.code === "CRASH")
      log.error(
        {
          route,
          code: error.code,
          sqlState:
            typeof error.details?.sqlState === "string"
              ? error.details.sqlState
              : undefined,
          constraint:
            typeof error.details?.constraint === "string"
              ? error.details.constraint
              : undefined,
        },
        "private route database operation failed",
      );
    const status =
      httpStatusForAuthz(error.code) ??
      (typeof reason === "string" && notFoundReasons.has(reason)
        ? 404
        : typeof reason === "string" && tooLargeReasons.has(reason)
          ? 413
          : error.code === "CONFIG"
            ? 400
            : error.code === "CONFLICT" || error.code === "PRECONDITION"
              ? 409
              : error.code === "EXECUTOR_UNAVAILABLE"
                ? 503
                : 500);

    return privateJson(
      {
        code: error.code,
        message: error.message,
        ...(typeof reason === "string" ||
        typeof error.details?.currentRevision === "number"
          ? {
              details: {
                ...(typeof reason === "string" ? { reason } : {}),
                ...(typeof error.details?.currentRevision === "number"
                  ? { currentRevision: error.details.currentRevision }
                  : {}),
              },
            }
          : {}),
      },
      status,
    );
  }
  // Query bodies and causes can contain private assertions; retain only safe driver diagnostics.
  log.error({ route, ...queryErrorDiagnostics(error) }, "private route failed");

  return privateJson({ code: "CRASH", message: "Request failed" }, 500);
}

export type PrivateJsonMessages = Readonly<{
  contentType: string;
  missing: string;
  tooLarge: string;
  tooLargeReason: string;
  invalid: string;
}>;

const defaultMessages: PrivateJsonMessages = {
  contentType: "This request requires application/json",
  missing: "A JSON request body is required",
  tooLarge: "The JSON request body exceeds its byte limit",
  tooLargeReason: "json_body_too_large",
  invalid: "The request body must be valid UTF-8 JSON",
};

/** Reads at most 256 KiB of strict UTF-8 JSON, refusing other content types. */
export async function readPrivateJson(
  request: Request,
  messages: PrivateJsonMessages = defaultMessages,
): Promise<unknown> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    throw new MaisterError("CONFIG", messages.contentType);
  if (!request.body) throw new MaisterError("CONFIG", messages.missing);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;

  try {
    for (;;) {
      const next = await reader.read();

      if (next.done) {
        complete = true;
        break;
      }
      length += next.value.byteLength;
      if (length > maximumBodyBytes)
        throw new MaisterError("CONFIG", messages.tooLarge, {
          details: { reason: messages.tooLargeReason },
        });
      chunks.push(next.value);
    }
  } finally {
    if (!complete) await reader.cancel();
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError)
      throw new MaisterError("CONFIG", messages.invalid);
    throw error;
  }
}
