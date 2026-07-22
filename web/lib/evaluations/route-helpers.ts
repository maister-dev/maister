import "server-only";

import type { Logger } from "pino";

import { NextResponse, type NextRequest } from "next/server";

import { isMaisterError, MaisterError } from "@/lib/errors";

// Evaluation Lab error mapping (plan §API "Common rules"): malformed/semantic
// config → 422, stale/idempotency/state race → 409, missing/cross-project → 404,
// dependency unavailable → 503. Distinct from the generic project-route helper
// (which maps CONFIG→400) because the evaluation contract separates malformed
// (still CONFIG) from missing (PRECONDITION → 404).
export function evalStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "PRECONDITION":
      return 404;
    case "CONFLICT":
      return 409;
    case "CONFIG":
      return 422;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

export function evalErrorResponse(err: unknown, log: Logger): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      err.details
        ? { code: err.code, message: err.message, details: err.details }
        : { code: err.code, message: err.message },
      { status: evalStatusForCode(err.code) },
    );
  }

  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "evaluation route unhandled error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function parseEvalJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Like `parseEvalJson` but for routes whose body is OPTIONAL: an absent/empty
// body resolves to `{}` (so a zod schema of all-optional fields validates),
// while a present-but-malformed body is still a typed CONFIG (422), never a 500.
export async function parseOptionalEvalJson(
  req: NextRequest,
): Promise<unknown> {
  const text = await req.text();

  if (!text.trim()) return {};

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Read + validate the mandatory If-Match optimistic-revision header for
// PATCH/DELETE (plan §API). Absent/non-integer → CONFIG (422) with a stable
// message so the client never silently overwrites a concurrent edit.
export function requireIfMatchRevision(req: NextRequest): number {
  const raw = req.headers.get("if-match");

  if (!raw) {
    throw new MaisterError(
      "CONFIG",
      "If-Match header with the expected revision is required",
    );
  }

  const value = Number(raw.replace(/^"|"$/g, "").trim());

  if (!Number.isInteger(value) || value < 1) {
    throw new MaisterError(
      "CONFIG",
      `If-Match must be a positive integer revision (got ${raw})`,
    );
  }

  return value;
}
