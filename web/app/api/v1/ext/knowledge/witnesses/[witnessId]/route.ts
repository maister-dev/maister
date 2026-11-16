import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { handleKnowledgeExt } from "@/lib/brain/knowledge-ext";
import { knowledgeJson } from "@/lib/brain/knowledge-http";
import { requireKnowledgeQueryKeys } from "@/lib/brain/knowledge-url";
import { getKnowledgeWitness } from "@/lib/brain/knowledge-witnesses";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ witnessId: string }> },
): Promise<NextResponse> {
  return handleKnowledgeExt(
    request,
    "knowledge:read",
    "GET /api/v1/ext/knowledge/witnesses/[witnessId]",
    async (principal) => {
      requireKnowledgeQueryKeys(request.nextUrl.searchParams, []);
      const { witnessId } = await params;

      return knowledgeJson(
        await getKnowledgeWitness(getDb(), principal, witnessId),
      );
    },
  );
}
