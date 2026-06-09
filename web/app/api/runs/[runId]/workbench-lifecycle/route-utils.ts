import "server-only";

import type { ZodType } from "zod";

import { NextResponse } from "next/server";
import pino from "pino";

import { isMaisterError, MaisterError } from "@/lib/errors";

export type RouteParams = { params: Promise<{ runId: string }> };

const log = pino({
  name: "api-workbench-lifecycle",
  level: process.env.LOG_LEVEL ?? "info",
});

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 400;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
    case "ACP_PROTOCOL":
      return 503;
    default:
      return 500;
  }
}

function errorPayload(err: MaisterError): Record<string, unknown> {
  const details = err as MaisterError & {
    pushRejected?: unknown;
    canForce?: unknown;
    retryHint?: unknown;
  };
  const retryHint =
    typeof details.retryHint === "string"
      ? details.retryHint
      : err.code === "EXECUTOR_UNAVAILABLE"
        ? "Check executor or remote availability, then retry."
        : null;

  return {
    code: err.code,
    message: err.message,
    ...(typeof details.pushRejected === "string"
      ? { pushRejected: details.pushRejected }
      : {}),
    ...(typeof details.canForce === "boolean"
      ? { canForce: details.canForce }
      : {}),
    ...(retryHint ? { retryHint } : {}),
  };
}

export function errorResponse(
  err: unknown,
  ctx: { runId: string; route: string },
): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "workbench lifecycle route error",
    );

    return NextResponse.json(errorPayload(err), { status });
  }

  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "workbench lifecycle unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    const text = await req.text();

    return text.trim() === "" ? {} : JSON.parse(text);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid POST body: ${(err as Error).message}`,
    );
  }
}

export function parseRouteBody<T>(schema: ZodType<T>, raw: unknown): T {
  try {
    return schema.parse(raw);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid POST body: ${(err as Error).message}`,
    );
  }
}
