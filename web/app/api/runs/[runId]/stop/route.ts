import "server-only";

import { NextResponse } from "next/server";

import { stopFlowWorkbench } from "@/lib/workbench-lifecycle/service";

import { errorResponse, type RouteParams } from "../workbench-lifecycle/route-utils";

export async function POST(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    return NextResponse.json(await stopFlowWorkbench(runId));
  } catch (err) {
    return errorResponse(err, { runId, route: "POST /api/runs/[runId]/stop" });
  }
}
