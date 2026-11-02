import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { isMaisterError, MaisterError } from "@/lib/errors";
import { queryErrorDiagnostics } from "@/lib/db/pg-error";
import { httpStatusForCode } from "@/lib/api/project-route-helpers";

const log = pino({
  name: "task-launch-http",
  level: process.env.LOG_LEVEL ?? "info",
});

/** A session cookie authenticates the user; same-origin protection authenticates the interactive request boundary. */
export function assertInteractiveLaunchOrigin(request: Request): void {
  if (
    request.headers.get("origin") !== new URL(request.url).origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new MaisterError(
      "UNAUTHORIZED",
      "An interactive launch must use the same origin",
      {
        details: { reason: "launch_interactive_origin_required" },
      },
    );
}

export async function readTaskLaunchBody(request: Request): Promise<unknown> {
  const text = await request.text();

  if (Buffer.byteLength(text, "utf8") > 65_536)
    throw new MaisterError("CONFIG", "Task launch body exceeds 64 KiB", {
      details: { reason: "launch_input_limit" },
    });
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new MaisterError("CONFIG", "Task launch body must be JSON", {
        details: { reason: "launch_request_invalid" },
      });
    throw error;
  }
}

export function taskLaunchRequestKey(request: Request): string {
  const key = request.headers.get("idempotency-key");

  if (!key || key.length > 256)
    throw new MaisterError("CONFIG", "A stable Idempotency-Key is required", {
      details: { reason: "launch_request_key_required" },
    });

  return key;
}

/** Query wrappers and nested Git causes never cross the public error boundary. */
export function taskLaunchErrorResponse(error: unknown): NextResponse {
  if (isMaisterError(error)) {
    const reason =
      typeof error.details?.reason === "string"
        ? error.details.reason
        : "launch_technical_precondition";
    const status =
      reason === "launch_not_found" ? 404 : httpStatusForCode(error.code);

    log.warn({ code: error.code, reason, status }, "task-launch-http-refused");

    return NextResponse.json(
      {
        code: error.code,
        message: "Task launch request could not be accepted",
        details: { reason },
      },
      { status },
    );
  }
  log.error(queryErrorDiagnostics(error), "task-launch-http-failed");

  return NextResponse.json(
    { code: "CRASH", message: "Task launch request could not be processed" },
    { status: 500 },
  );
}
