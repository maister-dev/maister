import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import {
  getSpecialistAssignmentAdmission,
  assertAssignmentAdmissionQuery,
} from "@/lib/specialist-assignments/admission-read";
import { knowledgeJson } from "@/lib/brain/knowledge-http";
import { handlePersonalAssignmentExt } from "@/lib/specialist-assignments/external";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<NextResponse> {
  return handlePersonalAssignmentExt(
    request,
    "assignments:read",
    "GET /api/v1/ext/specialist-assignments/:assignmentId/admission",
    async (userId) => {
      assertAssignmentAdmissionQuery(request.url);

      return knowledgeJson(
        await getSpecialistAssignmentAdmission(
          getDb(),
          userId,
          (await params).assignmentId,
        ),
      );
    },
  );
}
