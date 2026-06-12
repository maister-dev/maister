import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "api-packages",
  level: process.env.LOG_LEVEL ?? "info",
});

export function httpStatusForPackageCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "CONFIG":
      return 422;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "FLOW_INSTALL":
      return 502;
    default:
      return 500;
  }
}

export function packageErrorResponse(
  err: unknown,
  context: string,
): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForPackageCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ context, err: message }, "packages route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export function notFound(message: string): NextResponse {
  return NextResponse.json({ code: "NOT_FOUND", message }, { status: 404 });
}
