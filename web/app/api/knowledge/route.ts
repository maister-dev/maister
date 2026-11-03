import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { knowledgeSearchFromUrl } from "@/lib/brain/knowledge-url";
import { searchKnowledge } from "@/lib/brain/knowledge-search";
import {
  knowledgeSessionPrincipal,
  knowledgeJson,
  knowledgeErrorResponse,
} from "@/lib/brain/knowledge-http";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const principal = await knowledgeSessionPrincipal();

    return knowledgeJson(
      await searchKnowledge(
        getDb(),
        principal,
        knowledgeSearchFromUrl(request.nextUrl.searchParams),
      ),
    );
  } catch (error) {
    return knowledgeErrorResponse(error, "GET /api/knowledge");
  }
}
