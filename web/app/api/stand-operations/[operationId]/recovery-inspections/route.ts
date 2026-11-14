import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { z } from "zod";

import { requireActiveSession } from "@/lib/authz";
import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { inspectStandRecovery } from "@/lib/stand-operations/observe";
import { STAND_OPERATION_BODY_MAX_BYTES } from "@/lib/stand-operations/operation-types";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

const inspectionRequest = z
  .object({ expectedRevision: knowledgeRevisionSchema })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ operationId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();

    assertInteractiveLaunchOrigin(request);
    const { operationId } = await params;
    const parsed = inspectionRequest.safeParse(
      await readBoundedJson(request, STAND_OPERATION_BODY_MAX_BYTES),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "Select an exact operation revision for recovery inspection",
      );
    const observed = await inspectStandRecovery(
      getDb(),
      user.id,
      operationId,
      parsed.data.expectedRevision,
    );

    return privateJson(
      {
        id: observed.id,
        operationId,
        operationRevision: parsed.data.expectedRevision,
        targetIncarnation: observed.targetIncarnation,
        invocationId: observed.invocationId,
        observedState: observed.observedState,
        targetSequence: observed.targetSequence,
        capturedAt: observed.capturedAt.toISOString(),
        receivedAt: observed.receivedAt.toISOString(),
      },
      201,
    );
  } catch (error) {
    return privateErrorResponse(
      error,
      "POST /api/stand-operations/[operationId]/recovery-inspections",
    );
  }
}
