import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { parseScratchRequest } from "@/lib/scratch-runs/request";
import { launchScratchRun } from "@/lib/scratch-runs/service";
import { scratchLaunchInputSchema } from "@/lib/scratch-runs/types";

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
  try {
    const user = await requireActiveSession();
    const parsed = await parseScratchRequest(req, scratchLaunchInputSchema);

    log.debug(
      {
        userId: user.id,
        projectId: parsed.body.projectId,
        contentType: parsed.contentType,
        fileCount: parsed.uploadedFiles.length,
        metadataAttachmentCount: parsed.body.attachments.length,
      },
      "POST /api/scratch-runs parsed request",
    );

    const response = await launchScratchRun({
      body: parsed.body,
      uploadedFiles: parsed.uploadedFiles,
      userId: user.id,
    });

    return NextResponse.json(response, { status: 201 });
  } catch (err) {
    if (isMaisterError(err) && err.code === "PRECONDITION") {
      log.warn(
        { code: err.code, message: err.message },
        "POST /api/scratch-runs rejected",
      );
    }

    return errorResponse(err);
  }
}
