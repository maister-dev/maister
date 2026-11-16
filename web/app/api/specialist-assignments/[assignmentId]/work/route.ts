import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { decodeRouteParam } from "@/lib/route-params";
import { assignmentPageQuery } from "@/lib/specialist-assignments/http";
import { listSpecialistAssignmentWork } from "@/lib/specialist-assignments/pages";

const endpoint = "GET /api/specialist-assignments/[assignmentId]/work";

type RouteParams = { params: Promise<{ assignmentId: string }> };

export async function GET(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    return privateJson(
      await listSpecialistAssignmentWork(
        getDb(),
        user.id,
        decodeRouteParam((await params).assignmentId, "assignmentId"),
        assignmentPageQuery(request),
      ),
    );
  } catch (error) {
    return privateErrorResponse(error, endpoint);
  }
}
