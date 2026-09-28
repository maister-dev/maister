import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "librarian.http",
  level: process.env.LOG_LEVEL ?? "info",
});

// web.openapi.yaml `/api/librarian/*`: CONFIG is a 422, a spent daily cap a
// 429, an unknown or foreign id a 404 (existence-hidden), a busy or
// non-queued state a 409, an unavailable runner a 503.
export function librarianStatusFor(code: string, reason: unknown): number {
  if (reason === "not_found") return 404;
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
    case "BUDGET_EXCEEDED":
      return 429;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

export function librarianErrorResponse(
  err: unknown,
  route: string,
): NextResponse {
  if (isMaisterError(err)) {
    const reason = err.details?.reason;
    const status = librarianStatusFor(err.code, reason);

    return NextResponse.json(
      typeof reason === "string"
        ? { code: err.code, message: err.message, details: { reason } }
        : { code: err.code, message: err.message },
      { status },
    );
  }
  log.error(
    { route, err: err instanceof Error ? err.message : String(err) },
    "librarian route unhandled error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export function invalidBody(message: string): NextResponse {
  return NextResponse.json({ code: "CONFIG", message }, { status: 422 });
}

const SEQ = /^(0|[1-9][0-9]{0,18})$/;

/** A canonical non-negative decimal `seq`, else null. */
export function parseSeq(value: unknown): bigint | null {
  return typeof value === "string" && SEQ.test(value) ? BigInt(value) : null;
}
