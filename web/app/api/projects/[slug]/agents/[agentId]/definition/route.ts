import "server-only";

import { NextRequest, NextResponse } from "next/server";

import {
  resolveAgentActivityAccess,
  getAgentDefinitionView,
  agentActivityErrorResponse,
} from "@/lib/agents/activity-access";

type RouteParams = { params: Promise<{ slug: string; agentId: string }> };

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  try {
    const { slug, agentId } = await params;
    const access = await resolveAgentActivityAccess(slug, agentId);

    return NextResponse.json(await getAgentDefinitionView(access));
  } catch (error) {
    return agentActivityErrorResponse(error);
  }
}
