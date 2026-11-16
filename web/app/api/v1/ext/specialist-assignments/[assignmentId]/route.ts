import "server-only";

import { type NextRequest, NextResponse } from "next/server";

import { privateErrorResponse, privateJson } from "@/lib/api/private-json";
import { getDb } from "@/lib/db/client";
import { decodeRouteParam } from "@/lib/route-params";
import { getSpecialistAssignmentToken } from "@/lib/specialist-assignments/inspection";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> },
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    {
      scopeLabel: "assignments:read",
      endpoint: "GET /api/v1/ext/specialist-assignments/[assignmentId]",
      method: "GET",
    },
    async ({ actor }) =>
      privateJson(
        await getSpecialistAssignmentToken(
          getDb(),
          actor.tokenId,
          decodeRouteParam((await params).assignmentId, "assignmentId"),
        ),
      ),
    (error) => {
      const response = privateErrorResponse(
        error,
        "GET /api/v1/ext/specialist-assignments/[assignmentId]",
      );

      return response.status === 400
        ? new NextResponse(response.body, {
            status: 422,
            headers: response.headers,
          })
        : response;
    },
  );
}
