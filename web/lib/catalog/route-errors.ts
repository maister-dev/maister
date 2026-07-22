import "server-only";

import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { isMaisterError, MaisterError } from "@/lib/errors";

export function invalidBodyResponse(err: unknown): NextResponse {
  return catalogErrorResponse(
    new MaisterError(
      "CONFIG",
      `invalid request body: ${err instanceof Error ? err.message : String(err)}`,
    ),
  );
}

export function catalogErrorResponse(err: unknown): NextResponse {
  if (err instanceof SyntaxError || err instanceof ZodError) {
    return invalidBodyResponse(err);
  }

  if (isMaisterError(err)) {
    // (ADR-093, additive) `details` is forwarded only when the thrower set it —
    // e.g. the edit-lock's `{ reason: "edit_lock_not_held" }`, which is what
    // lets a client tell a lock refusal apart from a stale-CAS refusal (both
    // are 409). Mirrors `errorResponse` in `lib/api/project-route-helpers.ts`;
    // throwers redact, so this is never a server-only handle.
    return NextResponse.json(
      err.details
        ? { code: err.code, message: err.message, details: err.details }
        : { code: err.code, message: err.message },
      { status: httpStatusForCatalogError(err.code) },
    );
  }

  return NextResponse.json(
    {
      code: "CRASH",
      message: err instanceof Error ? err.message : String(err),
    },
    { status: 500 },
  );
}

function httpStatusForCatalogError(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}
