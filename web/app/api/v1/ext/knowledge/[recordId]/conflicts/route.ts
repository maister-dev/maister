import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { knowledgeJson } from "@/lib/brain/knowledge-http";
import { handleKnowledgeExt } from "@/lib/brain/knowledge-ext";
import { getKnowledgeConflictsPage } from "@/lib/brain/knowledge-conflicts";
import {
  knowledgeRecordSelector,
  knowledgePageFromUrl,
} from "@/lib/brain/knowledge-url";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ recordId: string }> },
): Promise<NextResponse> {
  return handleKnowledgeExt(
    request,
    "knowledge:read",
    "GET /api/v1/ext/knowledge/[recordId]/conflicts",
    async (principal) => {
      const { recordId } = await params;
      const page = knowledgePageFromUrl(request.nextUrl.searchParams);
      const selector = knowledgeRecordSelector(
        recordId,
        request.nextUrl.searchParams.get("revision"),
      );

      return knowledgeJson(
        await getKnowledgeConflictsPage(getDb(), principal, selector, page),
      );
    },
  );
}
