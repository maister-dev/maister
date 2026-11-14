import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { readBoundedJson } from "@/lib/http/bounded-json";
import {
  appendSpecialistAssignmentContext,
  getSpecialistAssignmentContext,
} from "@/lib/specialist-assignments/context";
import { selectAssignmentContextRevision } from "@/lib/specialist-assignments/context-selector";
import { decodeRouteParam } from "@/lib/route-params";

type RouteParams = { params: Promise<{ assignmentId: string }> };

export async function GET(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const assignmentId = decodeRouteParam(
      (await params).assignmentId,
      "assignmentId",
    );
    const revision = selectAssignmentContextRevision(
      request.nextUrl.searchParams,
    );

    return privateJson(
      await getSpecialistAssignmentContext(
        getDb(),
        user.id,
        assignmentId,
        revision,
      ),
    );
  } catch (error) {
    return privateErrorResponse(
      error,
      "GET /api/specialist-assignments/[assignmentId]/context",
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const assignmentId = decodeRouteParam(
      (await params).assignmentId,
      "assignmentId",
    );
    const context = await appendSpecialistAssignmentContext(
      getDb(),
      user.id,
      assignmentId,
      await readBoundedJson(request, 32768),
    );

    return privateJson(context);
  } catch (error) {
    return privateErrorResponse(
      error,
      "PATCH /api/specialist-assignments/[assignmentId]/context",
    );
  }
}
