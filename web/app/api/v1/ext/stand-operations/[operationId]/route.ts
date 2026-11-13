import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import {
  knowledgeErrorResponse,
  knowledgeJson,
} from "@/lib/brain/knowledge-http";
import { getDb } from "@/lib/db/client";
import { decodeRouteParam } from "@/lib/route-params";
import { getSpecialistStand } from "@/lib/stand-operations/agent-actions";
import { handleOwnedExt } from "@/lib/tokens/owned-ext-handler";

const endpoint = "GET /api/v1/ext/stand-operations/[operationId]";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ operationId: string }> },
): Promise<NextResponse> {
  return handleOwnedExt(
    request,
    { endpoint, scopeLabel: "targets:read", method: "GET" },
    async ({ actor }) =>
      knowledgeJson(
        await getSpecialistStand(
          getDb(),
          actor.tokenId,
          decodeRouteParam((await params).operationId, "operationId"),
        ),
      ),
    (error) => knowledgeErrorResponse(error, endpoint),
  );
}
