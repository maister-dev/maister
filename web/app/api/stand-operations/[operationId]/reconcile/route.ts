import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireActiveSession } from "@/lib/authz";
import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { STAND_OPERATION_BODY_MAX_BYTES } from "@/lib/stand-operations/operation-types";
import { reconcileStandRestart } from "@/lib/stand-operations/reconcile";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ operationId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    assertInteractiveLaunchOrigin(request);
    const { operationId } = await params;
    const operation = await reconcileStandRestart(
      getDb(),
      user.id,
      operationId,
      await readBoundedJson(request, STAND_OPERATION_BODY_MAX_BYTES),
    );

    return privateJson(
      operation,
      operation.effectState === "unknown" ? 202 : 200,
    );
  } catch (error) {
    return privateErrorResponse(
      error,
      "POST /api/stand-operations/[operationId]/reconcile",
    );
  }
}
