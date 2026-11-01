import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { httpStatusForAuthz, requireActiveSession } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";

const log = pino({ name: "run-peek", level: process.env.LOG_LEVEL ?? "info" });
const runIdSchema = z.string().uuid();

export function parsePeekRunId(value: string): string {
  const parsed = runIdSchema.safeParse(value);

  if (!parsed.success)
    throw new MaisterError("CONFIG", "Invalid Run identifier", {
      details: { reason: "invalid_run_id" },
    });

  return parsed.data;
}

export function peekQuery(
  request: Request,
  keys: readonly string[],
): Record<string, string> {
  const entries = [...new URL(request.url).searchParams.entries()];
  const unique = new Set(entries.map(([key]) => key));

  if (
    entries.length !== unique.size ||
    entries.some(([key]) => !keys.includes(key))
  ) {
    throw new MaisterError(
      "CONFIG",
      "Unsupported or duplicate peek query parameter",
      { details: { reason: "invalid_query" } },
    );
  }

  return Object.fromEntries(entries);
}

export async function peekResponse<T>(
  load: (userId: string) => Promise<T>,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const body = await load(user.id);

    return NextResponse.json(body, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const code = isMaisterError(error) ? error.code : "CRASH";
    const reason =
      isMaisterError(error) && typeof error.details?.reason === "string"
        ? error.details.reason
        : "read_failed";
    const status =
      httpStatusForAuthz(code) ??
      (reason === "run_unavailable"
        ? 404
        : code === "CONFIG"
          ? 400
          : code === "PRECONDITION" || code === "CONFLICT"
            ? 409
            : code === "EXECUTOR_UNAVAILABLE"
              ? 503
              : 500);

    if (status >= 500)
      log.error({ err: error, code, reason }, "peek read failed");
    else log.warn({ code, reason, status }, "peek read refused");

    return NextResponse.json(
      {
        code,
        reason,
        message:
          status >= 500
            ? "Run content could not be loaded"
            : "Run content is unavailable",
      },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
