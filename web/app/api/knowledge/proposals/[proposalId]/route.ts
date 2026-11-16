import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import {
  knowledgeSessionPrincipal,
  knowledgeJson,
  knowledgeErrorResponse,
} from "@/lib/brain/knowledge-http";
import { getKnowledgeProposal } from "@/lib/brain/knowledge-proposal-read";
import { requireKnowledgeQueryKeys } from "@/lib/brain/knowledge-url";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ proposalId: string }> },
): Promise<NextResponse> {
  try {
    const principal = await knowledgeSessionPrincipal();
    const { proposalId } = await params;

    requireKnowledgeQueryKeys(request.nextUrl.searchParams, []);

    return knowledgeJson(
      await getKnowledgeProposal(getDb(), principal, proposalId),
    );
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "GET /api/knowledge/proposals/[proposalId]",
    );
  }
}
