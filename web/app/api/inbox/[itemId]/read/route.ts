import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { markInboxItemRead } from "@/lib/social/inbox";

const log = pino({
  name: "api-inbox-read",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ itemId: string }> };

export async function PATCH(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { itemId } = await params;

  try {
    const user = await requireActiveSession();

    // Recipient-owned: a foreign or missing item answers 404 identically
    // (existence-hide, ADR-075 D9).
    const marked = await markInboxItemRead({ itemId, userId: user.id });

    if (!marked) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isMaisterError(err)) {
      const status = err.code === "UNAUTHENTICATED" ? 401 : 403;

      return NextResponse.json(
        { code: err.code, message: err.message },
        { status },
      );
    }
    log.error(
      { itemId, err: err instanceof Error ? err.message : String(err) },
      "inbox read unhandled error",
    );

    return NextResponse.json(
      { code: "CRASH", message: "internal error" },
      { status: 500 },
    );
  }
}
