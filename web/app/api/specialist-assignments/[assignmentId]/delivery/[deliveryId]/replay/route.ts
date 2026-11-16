import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { replaySpecialistAssignmentDelivery } from "@/lib/specialist-assignments/delivery-read";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { assignmentDeliveryReplaySchema } from "@/lib/specialist-assignments/delivery-read-types";
import { MaisterError } from "@/lib/errors";
import { requireActiveSession } from "@/lib/authz";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ assignmentId: string; deliveryId: string }> },
): Promise<NextResponse> {
  try {
    const userId = (await requireActiveSession()).id;

    assertInteractiveLaunchOrigin(request);
    const { assignmentId, deliveryId } = await params;
    const input = assignmentDeliveryReplaySchema.safeParse(
      await readBoundedJson(request, 4096),
    );

    if (!input.success)
      throw new MaisterError(
        "CONFIG",
        "Replay requires schemaVersion and the exact expectedStateSha256 only",
      );

    return privateJson(
      await replaySpecialistAssignmentDelivery(
        getDb(),
        userId,
        assignmentId,
        deliveryId,
        input.data,
      ),
    );
  } catch (error) {
    return privateErrorResponse(
      error,
      "POST /api/specialist-assignments/:assignmentId/delivery/:deliveryId/replay",
    );
  }
}
