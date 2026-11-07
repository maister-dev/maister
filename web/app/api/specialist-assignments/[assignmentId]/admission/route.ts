import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import {
  getSpecialistAssignmentAdmission,
  assertAssignmentAdmissionQuery,
} from "@/lib/specialist-assignments/admission-read";
import {
  knowledgeJson,
  knowledgeErrorResponse,
} from "@/lib/brain/knowledge-http";
import { requireActiveSession } from "@/lib/authz";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<NextResponse> {
  try {
    const userId = (await requireActiveSession()).id;

    assertAssignmentAdmissionQuery(request.url);

    return knowledgeJson(
      await getSpecialistAssignmentAdmission(
        getDb(),
        userId,
        (await params).assignmentId,
      ),
    );
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "GET /api/specialist-assignments/:assignmentId/admission",
    );
  }
}
