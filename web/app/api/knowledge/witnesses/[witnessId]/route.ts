import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { getKnowledgeWitness } from "@/lib/brain/knowledge-witnesses";
import {
  knowledgeSessionPrincipal,
  knowledgeJson,
  knowledgeErrorResponse,
} from "@/lib/brain/knowledge-http";
import { requireKnowledgeQueryKeys } from "@/lib/brain/knowledge-url";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ witnessId: string }> },
): Promise<NextResponse> {
  try {
    const principal = await knowledgeSessionPrincipal();
    const { witnessId } = await params;

    requireKnowledgeQueryKeys(request.nextUrl.searchParams, []);

    return knowledgeJson(
      await getKnowledgeWitness(getDb(), principal, witnessId),
    );
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "GET /api/knowledge/witnesses/[witnessId]",
    );
  }
}
