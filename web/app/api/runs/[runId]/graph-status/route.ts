import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { loadRunManifest } from "@/lib/queries/run-manifest";
import { getRunNodeStatuses } from "@/lib/queries/run-node-status";

const log = pino({
  name: "api-run-graph-status",
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

  log.error({ runId, err: message }, "GET /api/runs/[runId]/graph-status");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function GET(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const loaded = await loadRunManifest(runId);

    if (!loaded) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(loaded.projectId, "readBoard");

    const snapshot = await getRunNodeStatuses(runId);

    log.info(
      { runId, nodeCount: Object.keys(snapshot.nodes).length },
      "graph-status served",
    );

    return NextResponse.json(snapshot);
  } catch (err) {
    return errorResponse(err, runId);
  }
}
