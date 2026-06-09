import "server-only";

import { NextResponse } from "next/server";

import { dropWorkbench } from "@/lib/workbench-lifecycle/service";

import { errorResponse, type RouteParams } from "../workbench-lifecycle/route-utils";

export async function POST(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    return NextResponse.json(await dropWorkbench(runId));
  } catch (err) {
    return errorResponse(err, { runId, route: "POST /api/runs/[runId]/drop" });
  }
}
