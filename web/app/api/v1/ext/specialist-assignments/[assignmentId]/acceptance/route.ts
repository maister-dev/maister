import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { knowledgeJson } from "@/lib/brain/knowledge-http";
import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { decodeRouteParam } from "@/lib/route-params";
import { handlePersonalAssignmentExt } from "@/lib/specialist-assignments/external";
import { acceptSpecialistAssignment } from "@/lib/specialist-assignments/final-acceptance";

const endpoint =
  "POST /api/v1/ext/specialist-assignments/[assignmentId]/acceptance";

type RouteParams = { params: Promise<{ assignmentId: string }> };

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  return handlePersonalAssignmentExt(
    request,
    "assignments:accept",
    endpoint,
    async (userId) =>
      knowledgeJson(
        await acceptSpecialistAssignment(getDb(), {
          userId,
          assignmentId: decodeRouteParam(
            (await params).assignmentId,
            "assignmentId",
          ),
          value: await readBoundedJson(request, 32768),
        }),
      ),
  );
}
