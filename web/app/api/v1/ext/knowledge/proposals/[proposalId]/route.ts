import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { handleKnowledgeExt } from "@/lib/brain/knowledge-ext";
import { knowledgeJson } from "@/lib/brain/knowledge-http";
import { getKnowledgeProposal } from "@/lib/brain/knowledge-proposal-read";
import { requireKnowledgeQueryKeys } from "@/lib/brain/knowledge-url";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ proposalId: string }> },
): Promise<NextResponse> {
  return handleKnowledgeExt(
    request,
    "knowledge:read",
    "GET /api/v1/ext/knowledge/proposals/[proposalId]",
    async (principal) => {
      requireKnowledgeQueryKeys(request.nextUrl.searchParams, []);
      const { proposalId } = await params;

      return knowledgeJson(
        await getKnowledgeProposal(getDb(), principal, proposalId),
      );
    },
  );
}
