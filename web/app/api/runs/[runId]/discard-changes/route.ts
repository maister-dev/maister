import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  errorResponse,
  parseJsonBody,
  parseRouteBody,
  type RouteParams,
} from "../workbench-lifecycle/route-utils";

import { discardWorkbenchChanges } from "@/lib/workbench-git/service";

// ADR-181 D8/D18: no body field — the run id is the only locator.
const discardChangesBodySchema = z.object({}).strict();

export async function POST(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    parseRouteBody(discardChangesBodySchema, await parseJsonBody(req));

    return NextResponse.json(await discardWorkbenchChanges(runId));
  } catch (err) {
    return errorResponse(err, {
      runId,
      route: "POST /api/runs/[runId]/discard-changes",
    });
  }
}
