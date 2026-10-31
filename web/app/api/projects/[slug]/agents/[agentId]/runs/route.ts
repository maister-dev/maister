import "server-only";

import { NextRequest, NextResponse } from "next/server";

import {
  resolveAgentActivityAccess,
  agentActivityErrorResponse,
} from "@/lib/agents/activity-access";
import {
  getAgentRunHistory,
  loadAgentHistoryEvidence,
  type AgentHistoryFilter,
} from "@/lib/agents/activity-queries";
import { MaisterError } from "@/lib/errors";

type RouteParams = { params: Promise<{ slug: string; agentId: string }> };

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug, agentId } = await params;
    const access = await resolveAgentActivityAccess(slug, agentId);
    const search = req.nextUrl.searchParams;

    for (const key of search.keys()) {
      if (
        !["cursor", "limit", "status", "triggerSource", "outcome"].includes(
          key,
        ) ||
        search.getAll(key).length !== 1
      )
        throw new MaisterError("CONFIG", "Invalid or duplicate history filter");
    }
    const input: AgentHistoryFilter = {
      projectId: access.projectId,
      agentId: access.agentId,
      ...Object.fromEntries(search),
      ...(search.has("limit") ? { limit: Number(search.get("limit")) } : {}),
    };

    const page = await getAgentRunHistory(access.db, input);

    return NextResponse.json(
      access.canReadDefinition
        ? await loadAgentHistoryEvidence(access.db, page)
        : page,
    );
  } catch (error) {
    return agentActivityErrorResponse(error);
  }
}
