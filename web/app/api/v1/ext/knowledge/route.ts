import "server-only";

import { type NextRequest, type NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { knowledgeJson } from "@/lib/brain/knowledge-http";
import { handleKnowledgeExt } from "@/lib/brain/knowledge-ext";
import { searchKnowledge } from "@/lib/brain/knowledge-search";
import { knowledgeSearchFromUrl } from "@/lib/brain/knowledge-url";

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleKnowledgeExt(
    request,
    "knowledge:read",
    "GET /api/v1/ext/knowledge",
    async (principal) =>
      knowledgeJson(
        await searchKnowledge(
          getDb(),
          principal,
          knowledgeSearchFromUrl(request.nextUrl.searchParams),
        ),
      ),
    { installation: true, librarian: "read" },
  );
}
