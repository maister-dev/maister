import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { getCompanyAgentRunHistory } from "@/lib/agents/activity-queries";
import { requireActiveSession } from "@/lib/authz";
import {
  knowledgeErrorResponse,
  knowledgeJson,
} from "@/lib/brain/knowledge-http";
import { requireKnowledgeQueryKeys } from "@/lib/brain/knowledge-url";
import { getDb } from "@/lib/db/client";

type Context = Readonly<{ params: Promise<{ specialistId: string }> }>;

export async function GET(
  request: NextRequest,
  context: Context,
): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const { specialistId } = await context.params;
    const search = request.nextUrl.searchParams;

    requireKnowledgeQueryKeys(search, [
      "cursor",
      "limit",
      "status",
      "triggerSource",
      "outcome",
    ]);

    return knowledgeJson(
      await getCompanyAgentRunHistory(getDb(), user.id, {
        ...Object.fromEntries(search),
        agentId: specialistId,
        ...(search.has("limit") ? { limit: Number(search.get("limit")) } : {}),
      }),
    );
  } catch (error) {
    return knowledgeErrorResponse(
      error,
      "GET /api/specialists/:specialistId/runs",
    );
  }
}
