import "server-only";
import type { NextRequest } from "next/server";

import { NextResponse } from "next/server";

import { readBoundedJson } from "@/lib/http/bounded-json";
import { appendSpecialistAssignmentTokenContext } from "@/lib/specialist-assignments/context";
import { getDb } from "@/lib/db/client";
import {
  knowledgeJson,
  knowledgeErrorResponse,
} from "@/lib/brain/knowledge-http";
import { getSpecialistAssignmentTokenContext } from "@/lib/specialist-assignments/context";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";
import { decodeRouteParam } from "@/lib/route-params";
import { selectAssignmentContextRevision } from "@/lib/specialist-assignments/context-selector";
type RouteParams = { params: Promise<{ assignmentId: string }> };
export async function GET(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    {
      scopeLabel: "assignments:read",
      endpoint: "GET /api/v1/ext/specialist-assignments/[assignmentId]/context",
      method: "GET",
    },
    async ({ actor }) => {
      const revision = selectAssignmentContextRevision(
        request.nextUrl.searchParams,
      );

      return knowledgeJson(
        await getSpecialistAssignmentTokenContext(
          getDb(),
          actor.tokenId,
          decodeRouteParam((await params).assignmentId, "assignmentId"),
          revision,
        ),
      );
    },
    (error) => {
      const response = knowledgeErrorResponse(
        error,
        "GET /api/v1/ext/specialist-assignments/[assignmentId]/context",
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

export async function PATCH(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    {
      scopeLabel: "assignments:update",
      endpoint:
        "PATCH /api/v1/ext/specialist-assignments/[assignmentId]/context",
      method: "PATCH",
    },
    async ({ actor }) =>
      knowledgeJson(
        await appendSpecialistAssignmentTokenContext(
          getDb(),
          actor.tokenId,
          decodeRouteParam((await params).assignmentId, "assignmentId"),
          await readBoundedJson(request, 32768),
        ),
      ),
    (error) => {
      const response = knowledgeErrorResponse(
        error,
        "PATCH /api/v1/ext/specialist-assignments/[assignmentId]/context",
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
