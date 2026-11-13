import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import {
  knowledgeErrorResponse,
  knowledgeJson,
} from "@/lib/brain/knowledge-http";
import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { STAND_OPERATION_BODY_MAX_BYTES } from "@/lib/stand-operations/operation-types";
import { approveStandRestart } from "@/lib/stand-operations/restart-approval";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ operationId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    assertInteractiveLaunchOrigin(request);
    const { operationId } = await params;
    const receipt = await approveStandRestart(
      getDb(),
      user.id,
      operationId,
      await readBoundedJson(request, STAND_OPERATION_BODY_MAX_BYTES),
    );

    return knowledgeJson(receipt.approval, receipt.duplicate ? 200 : 201);
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "POST /api/stand-operations/[operationId]/approval",
    );
  }
}
