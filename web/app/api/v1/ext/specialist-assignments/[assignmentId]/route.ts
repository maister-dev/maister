import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { knowledgeJson } from "@/lib/brain/knowledge-http";
import { getDb } from "@/lib/db/client";
import { handlePersonalAssignmentExt } from "@/lib/specialist-assignments/external";
import { getSpecialistAssignment } from "@/lib/specialist-assignments/store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<NextResponse> {
  return handlePersonalAssignmentExt(
    request,
    "assignments:read",
    "GET /api/v1/ext/specialist-assignments/[assignmentId]",
    async (userId) => {
      const { assignmentId } = await params;

      return knowledgeJson(
        await getSpecialistAssignment(getDb(), userId, assignmentId),
      );
    },
  );
}
