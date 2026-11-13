import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import {
  knowledgeErrorResponse,
  knowledgeJson,
} from "@/lib/brain/knowledge-http";
import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { createStandOperation } from "@/lib/stand-operations/operation-intake";
import { STAND_OPERATION_BODY_MAX_BYTES } from "@/lib/stand-operations/operation-types";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    assertInteractiveLaunchOrigin(request);
    const { assignmentId } = await params;
    const receipt = await createStandOperation(
      getDb(),
      user.id,
      assignmentId,
      await readBoundedJson(request, STAND_OPERATION_BODY_MAX_BYTES),
    );

    return knowledgeJson(receipt.operation, receipt.duplicate ? 200 : 202);
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "POST /api/specialist-assignments/[assignmentId]/operations",
    );
  }
}
