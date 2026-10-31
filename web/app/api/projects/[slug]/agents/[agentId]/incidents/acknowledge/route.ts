import "server-only";

import { NextRequest, NextResponse } from "next/server";

import {
  resolveAgentActivityAccess,
  agentActivityErrorResponse,
} from "@/lib/agents/activity-access";
import {
  acknowledgeAgentEpisodes,
  agentEpisodeAcknowledgementSchema,
} from "@/lib/runs/agent-incident-projection";
import { requireProjectActionForUser } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";

type RouteParams = { params: Promise<{ slug: string; agentId: string }> };

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug, agentId } = await params;
    const access = await resolveAgentActivityAccess(slug, agentId);

    await requireProjectActionForUser(
      access.actor.id,
      access.projectId,
      "answerHitl",
    );
    const body = agentEpisodeAcknowledgementSchema.safeParse(await req.json());

    if (!body.success)
      throw new MaisterError("CONFIG", "Invalid episode acknowledgement body");

    return NextResponse.json(
      await acknowledgeAgentEpisodes(access.db, {
        projectId: access.projectId,
        agentId: access.agentId,
        userId: access.actor.id,
        episodes: body.data.episodes,
      }),
    );
  } catch (error) {
    return agentActivityErrorResponse(
      error instanceof SyntaxError
        ? new MaisterError("CONFIG", "Invalid JSON acknowledgement body")
        : error,
    );
  }
}
