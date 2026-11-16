import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { privateErrorResponse } from "@/lib/api/private-json";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { decodeRouteParam } from "@/lib/route-params";
import { stopRunForUser } from "@/lib/runs/stop";
import { cancelAssignmentExecution } from "@/lib/specialist-assignments/controls";
import { assignmentControlResponse } from "@/lib/specialist-assignments/http";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

const endpoint = "POST /api/specialist-assignments/[assignmentId]/cancel";

type RouteParams = { params: Promise<{ assignmentId: string }> };

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    assertInteractiveLaunchOrigin(request);

    return assignmentControlResponse(
      await cancelAssignmentExecution(
        getDb(),
        user.id,
        decodeRouteParam((await params).assignmentId, "assignmentId"),
        await readBoundedJson(request, 8192),
        (runId) => stopRunForUser(user.id, runId),
      ),
    );
  } catch (error) {
    return privateErrorResponse(error, endpoint);
  }
}
