import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { getSpecialistAssignmentDelivery } from "@/lib/specialist-assignments/delivery-read";
import { parseAssignmentDeliverySelection } from "@/lib/specialist-assignments/delivery-read-types";
import { requireActiveSession } from "@/lib/authz";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<NextResponse> {
  try {
    const userId = (await requireActiveSession()).id;
    const { assignmentId } = await params;

    return privateJson(
      await getSpecialistAssignmentDelivery(
        getDb(),
        userId,
        assignmentId,
        parseAssignmentDeliverySelection(request.url),
      ),
    );
  } catch (error) {
    return privateErrorResponse(
      error,
      "GET /api/specialist-assignments/:assignmentId/delivery",
    );
  }
}
