import "server-only";

import { NextResponse } from "next/server";

import {
  errorResponse,
  type RouteParams,
} from "../workbench-lifecycle/route-utils";

import { discardWorkbench } from "@/lib/workbench-lifecycle/service";

export async function POST(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    return NextResponse.json(await discardWorkbench(runId));
  } catch (err) {
    return errorResponse(err, {
      runId,
      route: "POST /api/runs/[runId]/discard",
    });
  }
}
