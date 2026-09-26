import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  errorResponse,
  parseJsonBody,
  parseRouteBody,
  type RouteParams,
} from "../workbench-lifecycle/route-utils";

import { requireActiveSession } from "@/lib/authz";
import { openPullRequest } from "@/lib/workbench-git/service";
import { branchNameSchema } from "@/lib/worktree";

// ADR-181 D11/D18: length-bounded strings and a boolean, never interpreted; the
// target is a branch name the promotion target rule re-checks server-side.
const openPrBodySchema = z
  .object({
    title: z.string().min(1).max(256).optional(),
    body: z.string().max(65_536).optional(),
    draft: z.boolean().optional(),
    targetBranch: branchNameSchema.optional(),
  })
  .strict();

export async function POST(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    // The session gate comes first: an anonymous caller never reaches a body
    // of up to 64 KiB. The service authorizes on the run's own project.
    await requireActiveSession();

    const body = parseRouteBody(openPrBodySchema, await parseJsonBody(req));

    return NextResponse.json(
      await openPullRequest(runId, body, { origin: new URL(req.url).origin }),
    );
  } catch (err) {
    return errorResponse(err, { runId, route: "POST /api/runs/[runId]/pr" });
  }
}
