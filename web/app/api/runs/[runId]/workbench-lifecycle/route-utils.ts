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

function httpStatusForCode(code: string, reason?: unknown): number {
  // C29: an unknown run is a 404 on every family-A route (the shared loader
  // tags it), not the 409 its PRECONDITION code would otherwise map to.
  if (code === "PRECONDITION" && reason === "run_not_found") return 404;

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

// ADR-181 D24: the body every run workbench route answers a typed error with —
// the code, the message and the `details.reason` token the UI branches on, and
// ONLY that token: other `details` fields are server-side context and never
// cross this boundary. The sync and promote routes keep their own status maps
// and share this body.
export function maisterErrorBody(err: MaisterError): {
  code: string;
  message: string;
  details?: { reason: string };
} {
  return {
    code: err.code,
    message: err.message,
    ...(typeof err.details?.reason === "string"
      ? { details: { reason: err.details.reason } }
      : {}),
  };
}

function errorPayload(err: MaisterError): Record<string, unknown> {
  const details = err as MaisterError & {
    pushRejected?: unknown;
    canForce?: unknown;
    retryHint?: unknown;
    remoteHead?: unknown;
    remoteRef?: unknown;
  };
  const retryHint =
    typeof details.retryHint === "string"
      ? details.retryHint
      : err.code === "EXECUTOR_UNAVAILABLE"
        ? "Check executor or remote availability, then retry."
        : null;

  const body = maisterErrorBody(err);

  return {
    code: body.code,
    message: body.message,
    ...(err.details?.reason === "workspace_preservation_failed" ||
    err.details?.reason === "workspace_git_identity_invalid"
      ? { reason: err.details.reason }
      : {}),
    ...(typeof details.pushRejected === "string"
      ? { pushRejected: details.pushRejected }
      : {}),
    ...(typeof details.canForce === "boolean"
      ? { canForce: details.canForce }
      : {}),
    // ADR-181 D4: what a force would replace — the forced retry sends the
    // head back as `expectedHead`.
    ...(typeof details.remoteHead === "string" || details.remoteHead === null
      ? { remoteHead: details.remoteHead }
      : {}),
    ...(typeof details.remoteRef === "string"
      ? { remoteRef: details.remoteRef }
      : {}),
    ...(retryHint ? { retryHint } : {}),
    // The top-level `reason` enum above is untouched.
    ...(body.details ? { details: body.details } : {}),
  };
}

export function errorResponse(
  err: unknown,
  ctx: { runId: string; route: string },
): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code, err.details?.reason);

    log.warn(
      {
        ...ctx,
        code: err.code,
        reason: err.details?.reason,
        message: err.message,
        status,
      },
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
