import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import {
  getSpecialistAssignmentAdmission,
  assertAssignmentAdmissionQuery,
} from "@/lib/specialist-assignments/admission-read";
import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { requireActiveSession } from "@/lib/authz";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<NextResponse> {
  try {
    const userId = (await requireActiveSession()).id;

    assertAssignmentAdmissionQuery(request.url);

    return privateJson(
      await getSpecialistAssignmentAdmission(
        getDb(),
        userId,
        (await params).assignmentId,
      ),
    );
  } catch (error) {
    return privateErrorResponse(
      error,
      "GET /api/specialist-assignments/:assignmentId/admission",
    );
  }
}
