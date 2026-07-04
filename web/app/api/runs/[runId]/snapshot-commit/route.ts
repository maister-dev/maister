import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  errorResponse,
  parseJsonBody,
  parseRouteBody,
  type RouteParams,
} from "../workbench-lifecycle/route-utils";

import { snapshotWorkbenchCommit } from "@/lib/workbench-lifecycle/service";

const snapshotCommitBodySchema = z
  .object({
    commitMessage: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0"), "no NUL"),
  })
  .strict();

export async function POST(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    const body = parseRouteBody(
      snapshotCommitBodySchema,
      await parseJsonBody(req),
    );

    return NextResponse.json(await snapshotWorkbenchCommit(runId, body));
  } catch (err) {
    return errorResponse(err, {
      runId,
      route: "POST /api/runs/[runId]/snapshot-commit",
    });
  }
}
