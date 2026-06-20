import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import {
  getRunChangeSummary,
  loadRunChangeSummaryAccess,
  parseRunChangeSummaryScope,
} from "@/lib/runs/change-summary";

const log = pino({
  name: "api-run-change-summary",
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
    case "CONFIG":
      return 400;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
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

  log.error({ runId, err: message }, "GET /api/runs/[runId]/change-summary");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function GET(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const scope = parseRunChangeSummaryScope(
      new URL(req.url).searchParams.get("scope"),
    );
    const access = await loadRunChangeSummaryAccess(runId);

    // A project-less local-package assistant run (ADR-097) is not addressable
    // through this project-scoped summary route — its diff is the Studio
    // editor's git-working-tree view, not a project workspace diff.
    if (!access || !access.projectId) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(
      access.projectId,
      access.runKind === "scratch" ? "readScratchRun" : "readBoard",
    );

    const summary = await getRunChangeSummary({ runId, scope });

    if (!summary) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    return NextResponse.json(summary);
  } catch (err) {
    return errorResponse(err, runId);
  }
}
