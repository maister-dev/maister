import "server-only";

import type { NextRequest } from "next/server";

import { NextResponse } from "next/server";

import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { decodeRouteParam } from "@/lib/route-params";
import { createStandOperation } from "@/lib/stand-operations/operation-intake";
import { getSpecialistStand } from "@/lib/stand-operations/agent-actions";
import { STAND_OPERATION_BODY_MAX_BYTES } from "@/lib/stand-operations/operation-types";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

const endpoint =
  "POST /api/v1/ext/specialist-assignments/[assignmentId]/operations";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    { endpoint, scopeLabel: "targets:read", method: "POST" },
    async ({ actor }) => {
      const { assignmentId } = await params;
      const result = await createStandOperation(
        getDb(),
        { tokenId: actor.tokenId },
        decodeRouteParam(assignmentId, "assignmentId"),
        await readBoundedJson(request, STAND_OPERATION_BODY_MAX_BYTES),
      );

      return privateJson(
        await getSpecialistStand(getDb(), actor.tokenId, result.operation.id),
        result.duplicate ? 200 : 202,
      );
    },
    (error) => {
      const response = privateErrorResponse(error, endpoint);

      return response.status === 400
        ? new NextResponse(response.body, {
            status: 422,
            headers: response.headers,
          })
        : response;
    },
  );
}
