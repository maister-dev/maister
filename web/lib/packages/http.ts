import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { configMutationError } from "@/lib/project-config-persistence/mutation-error";
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
    case "ACCOUNT_INACTIVE":
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
  const failure = configMutationError(err);

  if (isMaisterError(failure)) {
    return NextResponse.json(
      {
        code: failure.code,
        message: failure.message,
        // ADR-132: machine-readable refusal context (e.g. the attach
        // package_name_taken reason) — additive, absent when unset.
        ...(failure.details !== undefined ? { details: failure.details } : {}),
      },
      { status: httpStatusForPackageCode(failure.code) },
    );
  }
  const message = failure instanceof Error ? failure.message : String(failure);

  log.error({ context, err: message }, "packages route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export function notFound(message: string): NextResponse {
  return NextResponse.json({ code: "NOT_FOUND", message }, { status: 404 });
}
