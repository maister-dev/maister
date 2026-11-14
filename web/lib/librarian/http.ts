import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { queryErrorDiagnostics } from "@/lib/db/pg-error";
import { isMaisterError, MaisterError } from "@/lib/errors";

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
  const diagnostics = queryErrorDiagnostics(err);

  log.error({ route, ...diagnostics }, "librarian route unhandled error");
  if (
    diagnostics.sqlState &&
    (diagnostics.sqlState.startsWith("08") ||
      ["53300", "57014", "57P01", "57P02", "57P03"].includes(
        diagnostics.sqlState,
      ))
  ) {
    return NextResponse.json(
      {
        code: "EXECUTOR_UNAVAILABLE",
        message: "Librarian data is unavailable.",
      },
      { status: 503 },
    );
  }

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export function invalidBody(message: string): NextResponse {
  return NextResponse.json({ code: "CONFIG", message }, { status: 422 });
}

export function librarianWorkRequested(params?: URLSearchParams): boolean {
  const views = params?.getAll("view") ?? [];

  if (!views.length) return false;
  if (views.length === 1 && views[0] === "work") return true;
  throw new MaisterError("CONFIG", "Invalid Librarian read view.");
}

const SEQ = /^(0|[1-9][0-9]{0,18})$/;

/** A canonical non-negative decimal `seq`, else null. */
export function parseSeq(value: unknown): bigint | null {
  return typeof value === "string" && SEQ.test(value) ? BigInt(value) : null;
}
