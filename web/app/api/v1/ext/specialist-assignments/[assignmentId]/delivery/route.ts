import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { knowledgeJson } from "@/lib/brain/knowledge-http";
import { getDb } from "@/lib/db/client";
import { getSpecialistAssignmentDelivery } from "@/lib/specialist-assignments/delivery-read";
import { parseAssignmentDeliverySelection } from "@/lib/specialist-assignments/delivery-read-types";
import { handlePersonalAssignmentExt } from "@/lib/specialist-assignments/external";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<NextResponse> {
  return handlePersonalAssignmentExt(
    request,
    "assignments:read",
    "GET /api/v1/ext/specialist-assignments/:assignmentId/delivery",
    async (userId) => {
      const { assignmentId } = await params;

      return knowledgeJson(
        await getSpecialistAssignmentDelivery(
          getDb(),
          userId,
          assignmentId,
          parseAssignmentDeliverySelection(request.url),
        ),
      );
    },
  );
}
