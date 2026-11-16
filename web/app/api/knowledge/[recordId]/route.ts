import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import {
  knowledgeRecordSelector,
  requireKnowledgeQueryKeys,
} from "@/lib/brain/knowledge-url";
import {
  knowledgeSessionPrincipal,
  knowledgeJson,
  knowledgeErrorResponse,
} from "@/lib/brain/knowledge-http";

type RouteParams = { params: Promise<{ recordId: string }> };

export async function GET(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const principal = await knowledgeSessionPrincipal();
    const { recordId } = await params;

    requireKnowledgeQueryKeys(request.nextUrl.searchParams, ["revision"]);
    const selector = knowledgeRecordSelector(
      recordId,
      request.nextUrl.searchParams.get("revision"),
    );

    return knowledgeJson(
      await getKnowledgeRecord(getDb(), principal, selector),
    );
  } catch (error) {
    return knowledgeErrorResponse(error, "GET /api/knowledge/[recordId]");
  }
}
