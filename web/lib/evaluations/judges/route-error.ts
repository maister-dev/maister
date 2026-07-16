import "server-only";

import { NextResponse } from "next/server";

import { isMaisterError } from "@/lib/errors";
import { httpStatusForExtCode } from "@/lib/tokens/ext-handler";

// Map an evaluator-facade MaisterError to the ext HTTP contract. The facade adds
// UNAUTHORIZED (token not bound to a live judge attempt / wrong project → 403)
// and reuses PRECONDITION/CONFLICT/CONFIG on top of the shared ext mapping.
// Returns null for a non-MaisterError so the caller rethrows (500).
export function evaluatorErrorResponse(err: unknown): NextResponse | null {
  if (!isMaisterError(err)) return null;

  const status =
    err.code === "UNAUTHORIZED"
      ? 403
      : err.code === "UNAUTHENTICATED"
        ? 401
        : httpStatusForExtCode(err.code);

  return NextResponse.json(
    { code: err.code, message: err.message },
    { status },
  );
}
