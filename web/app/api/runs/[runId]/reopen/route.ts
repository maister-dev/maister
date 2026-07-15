import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schema from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import { reopenRun } from "@/lib/runs/reopen";

const { runs } = schema as unknown as Record<string, any>;

const log = pino({
  name: "api-run-reopen",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };

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
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ runId, err: message }, "POST /api/runs/[runId]/reopen");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function runProjectId(runId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ projectId: runs.projectId })
    .from(runs)
    .where(eq(runs.id, runId));

  return rows[0]?.projectId ?? null;
}

export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    const sessionUser = await requireActiveSession();

    // projectId is server-derived from the run row, never a body field.
    const projectId = await runProjectId(runId);

    if (!projectId) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `run not found: ${runId}` },
        { status: 404 },
      );
    }

    await requireProjectAction(projectId, "promoteRun");

    const result = await reopenRun({
      runId,
      actor: { type: "user", id: sessionUser.id },
    });

    return NextResponse.json(
      { ok: true, status: result.status, worktreeRevived: result.worktreeRevived },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err, runId);
  }
}
