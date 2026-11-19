import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { knowledgeJson } from "@/lib/brain/knowledge-http";
import { handleKnowledgeExt } from "@/lib/brain/knowledge-ext";
import { getKnowledgeRecord } from "@/lib/brain/knowledge-records";
import {
  knowledgeRecordSelector,
  requireKnowledgeQueryKeys,
} from "@/lib/brain/knowledge-url";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ recordId: string }> },
): Promise<NextResponse> {
  return handleKnowledgeExt(
    request,
    "knowledge:read",
    "GET /api/v1/ext/knowledge/[recordId]",
    async (principal) => {
      const { recordId } = await params;

      requireKnowledgeQueryKeys(request.nextUrl.searchParams, ["revision"]);
      const selector = knowledgeRecordSelector(
        recordId,
        request.nextUrl.searchParams.get("revision"),
      );

      return knowledgeJson(
        await getKnowledgeRecord(getDb(), principal, selector),
      );
    },
    { installation: true, librarian: "read" },
  );
}
