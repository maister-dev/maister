import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { getRunCostSummary } from "@/lib/queries/run";
import { loadRunChangeSummaryAccess } from "@/lib/runs/change-summary";

const log = pino({
  name: "api-run-cost-summary",
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

  log.error({ runId, err: message }, "GET /api/runs/[runId]/cost-summary");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// The live token-cost poll for the run inspector (mirrors change-summary): the
// LiveRunInspector re-fetches this on each SSE tick so the inspector's token /
// wall-clock facts grow during a live run instead of being frozen at the
// server-rendered snapshot. getRunCostSummary reconciles cost.jsonl → rollup.
export async function GET(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const access = await loadRunChangeSummaryAccess(runId);

    // A project-less local-package assistant run (ADR-097) is not addressable
    // through this project-scoped route — the Studio assistant surfaces its own
    // live token-budget meter in the docked panel header.
    if (!access || !access.projectId) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(
      access.projectId,
      access.runKind === "scratch" ? "readScratchRun" : "readBoard",
    );

    return NextResponse.json(await getRunCostSummary(runId));
  } catch (err) {
    return errorResponse(err, runId);
  }
}
