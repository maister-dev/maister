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
import {
  parseIfMatch,
  parsePatchScheduledLaunchBody,
  revisionHeaders,
} from "@/lib/scheduled-launches/http";
import {
  getScheduledLaunchDto,
  listScheduledLaunchEvents,
} from "@/lib/scheduled-launches/queries";
import { rearmScheduledLaunch } from "@/lib/scheduled-launches/service";
import { requiresLaunchUnattended } from "@/lib/runs/execution-policy";

const log = pino({
  name: "api-project-scheduled-launch",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string; launchId: string }> };

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, launchId } = await params;

  try {
    await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "readBoard");
    const intent = await getScheduledLaunchDto({
      projectId: project.id,
      scheduledLaunchId: launchId,
    });

    if (!intent) return notFoundResponse("scheduled launch not found");

    const events = await listScheduledLaunchEvents({
      projectId: project.id,
      scheduledLaunchId: launchId,
    });

    return NextResponse.json(
      { intent, events },
      { headers: revisionHeaders(intent.revision) },
    );
  } catch (error) {
    return errorResponse(error, log, slug);
  }
}

export async function PATCH(
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

    const body = parsePatchScheduledLaunchBody(await req.json());

    if (
      body.launchRequest.executionPolicy &&
      requiresLaunchUnattended(body.launchRequest.executionPolicy)
    ) {
      await requireProjectAction(project.id, "launchUnattended");
    }
    await rearmScheduledLaunch({
      projectId: project.id,
      scheduledLaunchId: launchId,
      actorUserId: user.id,
      expectedRevision,
      scheduledLocalTime: body.scheduledLocalTime,
      timezone: body.timezone,
      disambiguation: body.disambiguation,
      launchRequest: body.launchRequest,
    });
    const intent = await getScheduledLaunchDto({
      projectId: project.id,
      scheduledLaunchId: launchId,
    });

    if (!intent) {
      throw new MaisterError(
        "CRASH",
        "scheduled launch disappeared after update",
      );
    }
    log.info(
      { projectId: project.id, scheduledLaunchId: launchId, actorId: user.id },
      "scheduled launch rearmed",
    );

    return NextResponse.json(
      { intent },
      { headers: revisionHeaders(intent.revision) },
    );
  } catch (error) {
    return errorResponse(error, log, slug);
  }
}
