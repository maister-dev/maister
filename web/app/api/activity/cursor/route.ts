import "server-only";

/**
 * `POST /api/activity/cursor` — the reader advances their OWN read cursor
 * (`ATN-10`). There is no user id in the body: the only cursor this route can
 * reach is the session's, which is what keeps "mark as read" from being a
 * cross-user write.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import pino from "pino";

import { advanceActivityCursor } from "@/lib/queries/activity-cursor";
import { isMaisterError } from "@/lib/errors";
import { requireActiveSession } from "@/lib/authz";

const log = pino({
  name: "api-activity-cursor",
  level: process.env.LOG_LEVEL ?? "info",
});

const bodySchema = z.object({ seenThrough: z.string().datetime() });

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "PRECONDITION":
      return 409;
    default:
      return 500;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));

    if (!parsed.success) {
      return NextResponse.json(
        {
          code: "PRECONDITION",
          message: "seenThrough must be an ISO 8601 timestamp",
        },
        { status: 400 },
      );
    }

    const seenThrough = await advanceActivityCursor(
      user.id,
      new Date(parsed.data.seenThrough),
    );

    // The STORED cursor, which a stale request will find is newer than what it
    // asked for — the absorption is visible to the caller, not silent.
    return NextResponse.json({ seenThrough: seenThrough.toISOString() });
  } catch (err) {
    if (isMaisterError(err)) {
      return NextResponse.json(
        { code: err.code, message: err.message },
        { status: httpStatusForCode(err.code) },
      );
    }
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "activity cursor route unhandled error",
    );

    return NextResponse.json(
      { code: "CRASH", message: "internal error" },
      { status: 500 },
    );
  }
}
