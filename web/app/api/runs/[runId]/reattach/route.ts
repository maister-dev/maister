import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  errorResponse,
  parseJsonBody,
  parseRouteBody,
  type RouteParams,
} from "../workbench-lifecycle/route-utils";

import { reattachWorkbench } from "@/lib/workbench-git/service";

// ADR-181 D10/D18: no body field — the source is resolved server-side from the
// run's own git state, never chosen by the caller.
const reattachBodySchema = z.object({}).strict();

export async function POST(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    parseRouteBody(reattachBodySchema, await parseJsonBody(req));

    return NextResponse.json(await reattachWorkbench(runId));
  } catch (err) {
    return errorResponse(err, {
      runId,
      route: "POST /api/runs/[runId]/reattach",
    });
  }
}
