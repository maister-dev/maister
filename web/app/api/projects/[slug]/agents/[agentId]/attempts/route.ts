import "server-only";

import { NextRequest, NextResponse } from "next/server";

import {
  resolveAgentActivityAccess,
  agentActivityErrorResponse,
} from "@/lib/agents/activity-access";
import {
  getAgentAttemptHistory,
  loadAgentAttemptEvidence,
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
      if (!["cursor", "limit"].includes(key) || search.getAll(key).length !== 1)
        throw new MaisterError("CONFIG", "Invalid or duplicate attempt filter");
    }

    const page = await getAgentAttemptHistory(access.db, {
      projectId: access.projectId,
      agentId: access.agentId,
      ...(search.has("limit") ? { limit: Number(search.get("limit")) } : {}),
      ...(search.has("cursor") ? { cursor: search.get("cursor")! } : {}),
    });

    return NextResponse.json(
      access.canReadDefinition
        ? await loadAgentAttemptEvidence(access.db, page, {
            projectId: access.projectId,
            agentId: access.agentId,
          })
        : page,
    );
  } catch (error) {
    return agentActivityErrorResponse(error);
  }
}
