import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { getSpecialistAssignment } from "@/lib/specialist-assignments/store";
import { privateErrorResponse, privateJson } from "@/lib/api/private-json";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ assignmentId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { assignmentId } = await context.params;

    return privateJson(
      await getSpecialistAssignment(getDb(), user.id, assignmentId),
    );
  } catch (error) {
    return privateErrorResponse(error, "GET /api/specialist-assignments/:id");
  }
}
