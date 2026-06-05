import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";
import { getFlowLayout } from "@/lib/queries/flow-layout";
import { loadRunManifest } from "@/lib/queries/run-manifest";

const log = pino({
  name: "api-run-graph",
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

  log.error({ runId, err: message }, "GET /api/runs/[runId]/graph");

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

    const topology = buildGraphTopology(compileManifest(loaded.manifest));
    const layout = await getFlowLayout(loaded.flowId);

    log.info({ runId, nodes: topology.nodes.length }, "graph served");

    return NextResponse.json({ topology, layout });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
