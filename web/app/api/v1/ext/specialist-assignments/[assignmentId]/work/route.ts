import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { decodeRouteParam } from "@/lib/route-params";
import { handlePersonalAssignmentExt } from "@/lib/specialist-assignments/external";
import { privateJson } from "@/lib/api/private-json";
import { assignmentPageQuery } from "@/lib/specialist-assignments/http";
import { listSpecialistAssignmentWork } from "@/lib/specialist-assignments/pages";

const endpoint = "GET /api/v1/ext/specialist-assignments/[assignmentId]/work";

type RouteParams = { params: Promise<{ assignmentId: string }> };

export async function GET(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  return handlePersonalAssignmentExt(
    request,
    "assignments:read",
    endpoint,
    async (userId) =>
      privateJson(
        await listSpecialistAssignmentWork(
          getDb(),
          userId,
          decodeRouteParam((await params).assignmentId, "assignmentId"),
          assignmentPageQuery(request),
        ),
      ),
  );
}
