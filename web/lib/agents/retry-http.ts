import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { MaisterError, isMaisterError } from "@/lib/errors";

const log = pino({
  name: "agent-retry-http",
  level: process.env.LOG_LEVEL ?? "info",
});

export function agentRetryErrorResponse(error: unknown): NextResponse {
  if (isMaisterError(error)) {
    const reason =
      typeof error.details?.reason === "string" ? error.details.reason : null;
    const status =
      reason === "retry_source_unavailable" ||
      reason === "retry_intent_unavailable"
        ? 404
        : error.code === "CONFIG"
          ? 400
          : error.code === "UNAUTHENTICATED"
            ? 401
            : [
                  "UNAUTHORIZED",
                  "ACCOUNT_INACTIVE",
                  "PASSWORD_CHANGE_REQUIRED",
                ].includes(error.code)
              ? 403
              : reason === "upgrade_maintenance_fence" ||
                  error.code === "EXECUTOR_UNAVAILABLE"
                ? 503
                : 409;

    log.warn(
      { code: error.code, reason, status },
      "agent retry request refused",
    );

    return NextResponse.json(
      {
        code: error.code,
        message: error.message,
        ...(reason ? { reason } : {}),
      },
      { status },
    );
  }
  log.error(
    { errorType: error instanceof Error ? error.name : "unknown" },
    "agent retry request failed",
  );

  return NextResponse.json(
    { code: "CRASH", message: "Agent retry request failed" },
    { status: 500 },
  );
}

export async function readAgentRetryJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new MaisterError("CONFIG", "Request body must contain valid JSON", {
        details: { reason: "retry_request_invalid" },
      });
    throw error;
  }
}
