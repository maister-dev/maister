import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { markAllInboxRead } from "@/lib/social/inbox";

const log = pino({
  name: "api-inbox-read-all",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function POST(): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const updated = await markAllInboxRead({ userId: user.id });

    return NextResponse.json({ ok: true, updated });
  } catch (err) {
    if (isMaisterError(err)) {
      const status = err.code === "UNAUTHENTICATED" ? 401 : 403;

      return NextResponse.json(
        { code: err.code, message: err.message },
        { status },
      );
    }
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "inbox read-all unhandled error",
    );

    return NextResponse.json(
      { code: "CRASH", message: "internal error" },
      { status: 500 },
    );
  }
}
