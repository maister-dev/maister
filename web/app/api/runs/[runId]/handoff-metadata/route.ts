import "server-only";

import { NextResponse } from "next/server";

import { getWorkbenchHandoffMetadata } from "@/lib/workbench-lifecycle/service";

import { errorResponse, type RouteParams } from "../workbench-lifecycle/route-utils";

export async function GET(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    return NextResponse.json(await getWorkbenchHandoffMetadata(runId));
  } catch (err) {
    return errorResponse(err, {
      runId,
      route: "GET /api/runs/[runId]/handoff-metadata",
    });
  }
}
