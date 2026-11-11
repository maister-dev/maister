import "server-only";

import type { NextRequest } from "next/server";

import { NextResponse } from "next/server";

import {
  knowledgeErrorResponse,
  knowledgeJson,
} from "@/lib/brain/knowledge-http";
import { getDb } from "@/lib/db/client";
import { readBoundedJson } from "@/lib/http/bounded-json";
import { decodeRouteParam } from "@/lib/route-params";
import { acceptSpecialistWorkByToken } from "@/lib/specialist-assignments/work-acceptance";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

const endpoint =
  "POST /api/v1/ext/specialist-assignments/[assignmentId]/work/[workId]/decisions";

type RouteParams = {
  params: Promise<{ assignmentId: string; workId: string }>;
};

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    { scopeLabel: "assignments:accept", endpoint, method: "POST" },
    async ({ actor }) => {
      const { assignmentId, workId } = await params;

      return knowledgeJson(
        await acceptSpecialistWorkByToken(getDb(), {
          tokenId: actor.tokenId,
          boundRunId: actor.boundRunId,
          assignmentId: decodeRouteParam(assignmentId, "assignmentId"),
          workId: decodeRouteParam(workId, "workId"),
          value: await readBoundedJson(request, 32768),
        }),
      );
    },
    (error) => {
      const response = knowledgeErrorResponse(error, endpoint);

      return response.status === 400
        ? new NextResponse(response.body, {
            status: 422,
            headers: response.headers,
          })
        : response;
    },
  );
}
