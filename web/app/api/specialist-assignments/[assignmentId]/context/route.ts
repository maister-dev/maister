import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import {
  knowledgeErrorResponse,
  knowledgeJson,
} from "@/lib/brain/knowledge-http";
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

    return knowledgeJson(
      await getSpecialistAssignmentContext(
        getDb(),
        user.id,
        assignmentId,
        revision,
      ),
    );
  } catch (error) {
    return knowledgeErrorResponse(
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

    return knowledgeJson(context);
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "PATCH /api/specialist-assignments/[assignmentId]/context",
    );
  }
}
