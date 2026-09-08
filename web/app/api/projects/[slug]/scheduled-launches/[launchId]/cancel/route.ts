import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  errorResponse,
  notFoundResponse,
  resolveProject,
} from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { parseIfMatch, revisionHeaders } from "@/lib/scheduled-launches/http";
import { getScheduledLaunchDto } from "@/lib/scheduled-launches/queries";
import { cancelScheduledLaunch } from "@/lib/scheduled-launches/service";

const log = pino({
  name: "api-project-scheduled-launch-cancel",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string; launchId: string }> };

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, launchId } = await params;

  try {
    const user = await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageSchedules");
    await requireProjectAction(project.id, "launchRun");

    const expectedRevision = parseIfMatch(req.headers.get("If-Match"));
    const existing = await getScheduledLaunchDto({
      projectId: project.id,
      scheduledLaunchId: launchId,
    });

    if (!existing) return notFoundResponse("scheduled launch not found");

    await cancelScheduledLaunch({
      projectId: project.id,
      scheduledLaunchId: launchId,
      actorUserId: user.id,
      expectedRevision,
    });
    const intent = await getScheduledLaunchDto({
      projectId: project.id,
      scheduledLaunchId: launchId,
    });

    if (!intent) {
      throw new MaisterError(
        "CRASH",
        "scheduled launch disappeared after cancellation",
      );
    }
    log.info(
      { projectId: project.id, scheduledLaunchId: launchId, actorId: user.id },
      "scheduled launch cancelled",
    );

    return NextResponse.json(
      { intent },
      { headers: revisionHeaders(intent.revision) },
    );
  } catch (error) {
    return errorResponse(error, log, slug);
  }
}
