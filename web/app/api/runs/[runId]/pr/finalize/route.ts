import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  errorResponse,
  parseJsonBody,
  parseRouteBody,
  type RouteParams,
} from "../../workbench-lifecycle/route-utils";

import { requireActiveSession } from "@/lib/authz";
import { finalizePullRequestRun } from "@/lib/workbench-git/service";

// ADR-181 C23: both fields exist for a Review run only (forwarded to
// `promoteRun`); the service refuses them for any other status.
const finalizePrBodySchema = z
  .object({
    reviewedTargetCommit: z.string().min(7).max(64).optional(),
    allowTargetDrift: z.boolean().optional(),
  })
  .strict();

export async function POST(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const body = parseRouteBody(finalizePrBodySchema, await parseJsonBody(req));

    return NextResponse.json(await finalizePullRequestRun(runId, body));
  } catch (err) {
    return errorResponse(err, {
      runId,
      route: "POST /api/runs/[runId]/pr/finalize",
    });
  }
}
