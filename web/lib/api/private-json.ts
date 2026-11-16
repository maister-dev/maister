import "server-only";

import type { BoundedJsonMessages } from "@/lib/http/bounded-json";

import { NextResponse } from "next/server";
import pino from "pino";

import { httpStatusForAuthz } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";
import { readBoundedJson } from "@/lib/http/bounded-json";

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

export type PrivateJsonMessages = BoundedJsonMessages;

const defaultMessages: PrivateJsonMessages = {
  contentType: "This request requires application/json",
  missing: "A JSON request body is required",
  tooLarge: "The JSON request body exceeds its byte limit",
  tooLargeReason: "json_body_too_large",
  invalid: "The request body must be valid UTF-8 JSON",
};

/** Reads at most 256 KiB of strict UTF-8 JSON, refusing other content types. */
export function readPrivateJson(
  request: Request,
  messages: PrivateJsonMessages = defaultMessages,
): Promise<unknown> {
  return readBoundedJson(request, maximumBodyBytes, messages);
}
