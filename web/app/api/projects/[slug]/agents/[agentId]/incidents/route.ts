import "server-only";

import { NextRequest, NextResponse } from "next/server";

import {
  resolveAgentActivityAccess,
  agentActivityErrorResponse,
} from "@/lib/agents/activity-access";
import { listAgentIncidentPage } from "@/lib/runs/agent-incident-projection";
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
        !["cursor", "limit", "state", "acknowledged"].includes(key) ||
        search.getAll(key).length !== 1
      )
        throw new MaisterError(
          "CONFIG",
          "Invalid or duplicate incident filter",
        );
    }
    const state = search.get("state");
    const acknowledged = search.get("acknowledged");

    if (state !== null && state !== "open" && state !== "resolved")
      throw new MaisterError("CONFIG", "Invalid incident state filter");
    if (
      acknowledged !== null &&
      acknowledged !== "true" &&
      acknowledged !== "false"
    )
      throw new MaisterError(
        "CONFIG",
        "Invalid incident acknowledgement filter",
      );

    return NextResponse.json(
      await listAgentIncidentPage(access.db, {
        projectId: access.projectId,
        agentId: access.agentId,
        userId: access.actor.id,
        ...(search.has("cursor") ? { cursor: search.get("cursor")! } : {}),
        ...(search.has("limit") ? { limit: Number(search.get("limit")) } : {}),
        ...(state !== null ? { state } : {}),
        ...(acknowledged !== null
          ? { acknowledged: acknowledged === "true" }
          : {}),
      }),
    );
  } catch (error) {
    return agentActivityErrorResponse(error);
  }
}
