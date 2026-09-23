import "server-only";

import { NextResponse } from "next/server";

import {
  errorResponse,
  type RouteParams,
} from "../workbench-lifecycle/route-utils";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  gitStateProjectId,
  loadGitState,
} from "@/lib/workbench-git/read-model";

// ADR-181 D3/D23: branch names, SHAs, counts and ref names — the class the run
// header already shows members — so `recoverRun`, below `readRepoFiles`. The
// project is derived from the run row, never from the request.
export async function GET(
  req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    const user = await requireActiveSession();
    const projectId = await gitStateProjectId(runId);

    await requireProjectAction(projectId, "recoverRun");

    return NextResponse.json(
      await loadGitState({
        runId,
        viewerUserId: user.id,
        origin: new URL(req.url).origin,
      }),
    );
  } catch (err) {
    return errorResponse(err, {
      runId,
      route: "GET /api/runs/[runId]/git-state",
    });
  }
}
