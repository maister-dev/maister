import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { decodeRouteParam } from "@/lib/route-params";
import { acceptSpecialistAssignment } from "@/lib/specialist-assignments/final-acceptance";

const endpoint = "POST /api/specialist-assignments/[assignmentId]/acceptance";

type RouteParams = { params: Promise<{ assignmentId: string }> };

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    return privateJson(
      await acceptSpecialistAssignment(getDb(), {
        userId: user.id,
        assignmentId: decodeRouteParam(
          (await params).assignmentId,
          "assignmentId",
        ),
        value: await readBoundedJson(request, 32768),
      }),
    );
  } catch (error) {
    return privateErrorResponse(error, endpoint);
  }
}
