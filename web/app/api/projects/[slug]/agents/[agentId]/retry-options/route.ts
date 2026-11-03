import { NextRequest, NextResponse } from "next/server";

import { resolveAgentActivityAccess } from "@/lib/agents/activity-access";
import { getAgentRetryBatchOptions } from "@/lib/agents/retry-batch";
import {
  agentRetryErrorResponse,
  readAgentRetryJson,
} from "@/lib/agents/retry-http";
import { MaisterError } from "@/lib/errors";

type Context = { params: Promise<{ slug: string; agentId: string }> };

export async function GET(
  request: NextRequest,
  { params }: Context,
): Promise<NextResponse> {
  try {
    const { slug, agentId } = await params;
    const access = await resolveAgentActivityAccess(slug, agentId);
    const search = request.nextUrl.searchParams;

    if (
      [...search.keys()].some(
        (key) =>
          !["cursor", "runnerId"].includes(key) ||
          search.getAll(key).length !== 1,
      )
    )
      throw new MaisterError("CONFIG", "Invalid batch retry preview filters");

    return NextResponse.json(
      await getAgentRetryBatchOptions(
        access.db,
        {
          projectId: access.projectId,
          agentId: access.agentId,
          userId: access.actor.id,
        },
        {
          ...(search.has("cursor") ? { cursor: search.get("cursor")! } : {}),
          ...(search.has("runnerId")
            ? { runnerId: search.get("runnerId")! }
            : {}),
        },
      ),
    );
  } catch (error) {
    return agentRetryErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: Context,
): Promise<NextResponse> {
  try {
    const { slug, agentId } = await params;
    const access = await resolveAgentActivityAccess(slug, agentId);
    const body = await readAgentRetryJson(request);

    return NextResponse.json(
      await getAgentRetryBatchOptions(
        access.db,
        {
          projectId: access.projectId,
          agentId: access.agentId,
          userId: access.actor.id,
        },
        body,
      ),
    );
  } catch (error) {
    return agentRetryErrorResponse(error);
  }
}
