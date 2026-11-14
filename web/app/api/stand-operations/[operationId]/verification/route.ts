import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { z } from "zod";

import { requireActiveSession } from "@/lib/authz";
import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { knowledgeRevisionSchema } from "@/lib/brain/knowledge-types";
import { getDb } from "@/lib/db/client";
import { MaisterError } from "@/lib/errors";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { STAND_OPERATION_BODY_MAX_BYTES } from "@/lib/stand-operations/operation-types";
import { verifyStandHealth } from "@/lib/stand-operations/verify";
import { assertInteractiveLaunchOrigin } from "@/lib/tasks/launch-http";

const verificationRequest = z
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
    const parsed = verificationRequest.safeParse(
      await readBoundedJson(request, STAND_OPERATION_BODY_MAX_BYTES),
    );

    if (!parsed.success)
      throw new MaisterError(
        "CONFIG",
        "Select an exact operation revision for verification",
      );
    const operation = await verifyStandHealth(
      getDb(),
      user.id,
      operationId,
      parsed.data.expectedRevision,
    );

    return privateJson(operation, 200);
  } catch (error) {
    return privateErrorResponse(
      error,
      "POST /api/stand-operations/[operationId]/verification",
    );
  }
}
