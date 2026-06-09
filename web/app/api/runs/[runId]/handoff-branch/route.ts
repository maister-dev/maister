import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { branchNameSchema, remoteNameSchema } from "@/lib/worktree";
import { createWorkbenchHandoffBranch } from "@/lib/workbench-lifecycle/service";

import {
  errorResponse,
  parseJsonBody,
  parseRouteBody,
  type RouteParams,
} from "../workbench-lifecycle/route-utils";

const handoffBranchBodySchema = z
  .object({
    remote: remoteNameSchema,
    handoffBranch: branchNameSchema,
  })
  .strict();

export async function POST(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    const body = parseRouteBody(handoffBranchBodySchema, await parseJsonBody(req));

    return NextResponse.json(
      await createWorkbenchHandoffBranch(runId, body),
    );
  } catch (err) {
    return errorResponse(err, {
      runId,
      route: "POST /api/runs/[runId]/handoff-branch",
    });
  }
}
