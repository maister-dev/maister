import "server-only";

import type { KnowledgePrincipal } from "./knowledge-types";

import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, httpStatusForAuthz } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";

const log = pino({
  name: "brain:knowledge-http",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function knowledgeSessionPrincipal(): Promise<KnowledgePrincipal> {
  return { kind: "user", userId: (await requireActiveSession()).id };
}

export function knowledgeJson(value: unknown, status = 200): NextResponse {
  return NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      Vary: "Cookie, Authorization",
    },
  });
}

export function knowledgeErrorResponse(
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
        "knowledge database operation failed",
      );
    const status =
      httpStatusForAuthz(error.code) ??
      (reason === "knowledge_reference_unavailable" ||
      reason === "company_binding_reference_unavailable"
        ? 404
        : reason === "knowledge_body_too_large"
          ? 413
          : error.code === "CONFIG"
            ? 400
            : error.code === "CONFLICT" || error.code === "PRECONDITION"
              ? 409
              : error.code === "EXECUTOR_UNAVAILABLE"
                ? 503
                : 500);

    return knowledgeJson(
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
  log.error(
    { route, ...queryErrorDiagnostics(error) },
    "knowledge route failed",
  );

  return knowledgeJson(
    { code: "CRASH", message: "Native knowledge request failed" },
    500,
  );
}

export async function readKnowledgeJson(request: Request): Promise<unknown> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    throw new MaisterError(
      "CONFIG",
      "Native knowledge writes require application/json",
    );
  if (!request.body)
    throw new MaisterError(
      "CONFIG",
      "A native knowledge JSON body is required",
    );
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
      if (length > 262144)
        throw new MaisterError(
          "CONFIG",
          "Native knowledge body exceeds its byte limit",
          { details: { reason: "knowledge_body_too_large" } },
        );
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
      throw new MaisterError(
        "CONFIG",
        "Native knowledge body must be valid UTF-8 JSON",
      );
    throw error;
  }
}
