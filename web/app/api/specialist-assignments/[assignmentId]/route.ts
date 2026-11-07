import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getSpecialistAssignment } from "@/lib/specialist-assignments/store";
import {
  knowledgeErrorResponse,
  knowledgeJson,
} from "@/lib/brain/knowledge-http";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ assignmentId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { assignmentId } = await context.params;

    return knowledgeJson(
      await getSpecialistAssignment(getDb(), user.id, assignmentId),
    );
  } catch (error) {
    return knowledgeErrorResponse(error, "GET /api/specialist-assignments/:id");
  }
}
