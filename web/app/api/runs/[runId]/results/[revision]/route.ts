import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import {
  httpStatusForCode,
  notFoundResponse,
} from "@/lib/api/project-route-helpers";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import {
  loadRetainedResultForUser,
  retainedResultRevision,
} from "@/lib/run-results/retained-result";

const log = pino({
  name: "api-retained-result",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string; revision: string }> },
): Promise<NextResponse> {
  const { runId, revision } = await params;

  try {
    const user = await requireActiveSession();
    const result = await loadRetainedResultForUser(getDb(), user.id, {
      runId,
      revision: retainedResultRevision(revision),
    });

    if (!result) return notFoundResponse("Retained result not found");

    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (isMaisterError(error)) {
      const status = httpStatusForCode(error.code);

      log.warn(
        { code: error.code, status },
        "retained result inspection refused",
      );

      return NextResponse.json(
        { code: error.code, message: error.message },
        { status },
      );
    }
    log.error(
      { errorType: error instanceof Error ? error.name : typeof error },
      "retained result inspection failed",
    );

    return NextResponse.json(
      { code: "CRASH", message: "internal error" },
      { status: 500 },
    );
  }
}
