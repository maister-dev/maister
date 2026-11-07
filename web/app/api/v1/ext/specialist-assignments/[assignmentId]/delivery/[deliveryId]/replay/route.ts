import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { knowledgeJson } from "@/lib/brain/knowledge-http";
import { getDb } from "@/lib/db/client";
import { replaySpecialistAssignmentDelivery } from "@/lib/specialist-assignments/delivery-read";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { assignmentDeliveryReplaySchema } from "@/lib/specialist-assignments/delivery-read-types";
import { MaisterError } from "@/lib/errors";
import { handlePersonalAssignmentExt } from "@/lib/specialist-assignments/external";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ assignmentId: string; deliveryId: string }> },
): Promise<NextResponse> {
  return handlePersonalAssignmentExt(
    request,
    "assignments:recover",
    "POST /api/v1/ext/specialist-assignments/:assignmentId/delivery/:deliveryId/replay",
    async (userId) => {
      const { assignmentId, deliveryId } = await params;
      const input = assignmentDeliveryReplaySchema.safeParse(
        await readBoundedJson(request, 4096),
      );

      if (!input.success)
        throw new MaisterError(
          "CONFIG",
          "Replay requires schemaVersion and the exact expectedStateSha256 only",
        );

      return knowledgeJson(
        await replaySpecialistAssignmentDelivery(
          getDb(),
          userId,
          assignmentId,
          deliveryId,
          input.data,
        ),
      );
    },
  );
}
