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
import { MaisterError } from "@/lib/errors";
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
    const values = request.nextUrl.searchParams.getAll("revision");
    const raw = values[0];

    if (
      values.length > 1 ||
      (raw !== undefined &&
        (!/^(0|[1-9][0-9]*)$/.test(raw) ||
          !Number.isSafeInteger(Number(raw)) ||
          Number(raw) > 2147483647))
    )
      throw new MaisterError(
        "CONFIG",
        "Context revision must be one canonical nonnegative integer",
      );

    return knowledgeJson(
      await getSpecialistAssignmentContext(
        getDb(),
        user.id,
        assignmentId,
        raw === undefined ? undefined : Number(raw),
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
