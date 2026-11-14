import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { decodeRouteParam } from "@/lib/route-params";
import { handlePersonalAssignmentExt } from "@/lib/specialist-assignments/external";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { continueAssignment } from "@/lib/specialist-assignments/controls";
import { assignmentControlResponse } from "@/lib/specialist-assignments/http";

const endpoint =
  "POST /api/v1/ext/specialist-assignments/[assignmentId]/continue";

type RouteParams = { params: Promise<{ assignmentId: string }> };

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  return handlePersonalAssignmentExt(
    request,
    "assignments:recover",
    endpoint,
    async (userId) =>
      assignmentControlResponse(
        await continueAssignment(
          getDb(),
          userId,
          decodeRouteParam((await params).assignmentId, "assignmentId"),
          await readBoundedJson(request, 8192),
        ),
      ),
  );
}
