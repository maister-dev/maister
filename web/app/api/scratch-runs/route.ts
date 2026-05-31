import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { launchScratchRun } from "@/lib/scratch-runs/service";
import {
  scratchLaunchInputSchema,
  type ScratchLaunchInput,
} from "@/lib/scratch-runs/types";

const log = pino({
  name: "api-scratch-runs",
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
    case "CONFIG":
      return 400;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
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

  log.error({ err: message }, "POST /api/scratch-runs unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: ScratchLaunchInput;

  try {
    body = scratchLaunchInputSchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid POST body: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  try {
    const user = await requireActiveSession();
    const response = await launchScratchRun({ body, userId: user.id });

    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
