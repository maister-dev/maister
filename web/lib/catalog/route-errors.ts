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
    return NextResponse.json(
      { code: err.code, message: err.message },
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
