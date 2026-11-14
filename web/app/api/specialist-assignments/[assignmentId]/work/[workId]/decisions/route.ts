import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { decodeRouteParam } from "@/lib/route-params";
import { decideSpecialistWork } from "@/lib/specialist-assignments/work-decision";

const endpoint =
  "POST /api/specialist-assignments/[assignmentId]/work/[workId]/decisions";

type RouteParams = {
  params: Promise<{ assignmentId: string; workId: string }>;
};

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { assignmentId, workId } = await params;

    return privateJson(
      await decideSpecialistWork(getDb(), {
        userId: user.id,
        assignmentId: decodeRouteParam(assignmentId, "assignmentId"),
        workId: decodeRouteParam(workId, "workId"),
        value: await readBoundedJson(request, 32768),
      }),
    );
  } catch (error) {
    return privateErrorResponse(error, endpoint);
  }
}
