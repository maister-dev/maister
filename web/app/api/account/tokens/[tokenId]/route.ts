import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { revokeOwnerToken } from "@/lib/tokens/revoke";

const log = pino({
  name: "api-account-tokens-id",
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
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "CONFIG":
      return 422;
    default:
      return 500;
  }
}

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }

  const message = err instanceof Error ? err.message : String(err);

  log.error({ err: message }, "account tokens/[tokenId] route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ tokenId: string }> };

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { tokenId } = await params;

  try {
    const user = await requireActiveSession();
    const { outcome } = await revokeOwnerToken({
      tokenId,
      ownerUserId: user.id,
    });

    if (outcome === "not-found") {
      return NextResponse.json(
        { code: "NOT_FOUND", message: "token not found" },
        { status: 404 },
      );
    }

    log.info({ tokenId, ownerUserId: user.id, outcome }, "token revoked");

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
