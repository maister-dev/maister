import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import {
  knowledgeRecordSelector,
  knowledgePageFromUrl,
} from "@/lib/brain/knowledge-url";
import { getKnowledgeEvidencePage } from "@/lib/brain/knowledge-evidence-page";
import {
  knowledgeSessionPrincipal,
  knowledgeJson,
  knowledgeErrorResponse,
} from "@/lib/brain/knowledge-http";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ recordId: string }> },
): Promise<NextResponse> {
  try {
    const principal = await knowledgeSessionPrincipal();
    const { recordId } = await params;
    const page = knowledgePageFromUrl(request.nextUrl.searchParams);
    const selector = knowledgeRecordSelector(
      recordId,
      request.nextUrl.searchParams.get("revision"),
    );

    return knowledgeJson(
      await getKnowledgeEvidencePage(getDb(), principal, selector, page),
    );
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "GET /api/knowledge/[recordId]/evidence",
    );
  }
}
