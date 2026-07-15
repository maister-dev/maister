import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { errorResponse, resolveProject } from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import {
  parseCreateScheduledLaunchBody,
  revisionHeaders,
} from "@/lib/scheduled-launches/http";
import { getScheduledLaunchDto } from "@/lib/scheduled-launches/queries";
import { createScheduledLaunch } from "@/lib/scheduled-launches/service";
import { requiresLaunchUnattended } from "@/lib/runs/execution-policy";

const log = pino({
  name: "api-project-scheduled-launches",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string }> };

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    const user = await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageSchedules");
    await requireProjectAction(project.id, "launchRun");

    const body = parseCreateScheduledLaunchBody(await req.json());
    const idempotencyKey = req.headers.get("Idempotency-Key");

    if (!idempotencyKey) {
      throw new MaisterError("CONFIG", "Idempotency-Key is required");
    }
    if (
      body.launchRequest.executionPolicy &&
      requiresLaunchUnattended(body.launchRequest.executionPolicy)
    ) {
      await requireProjectAction(project.id, "launchUnattended");
    }

    const created = await createScheduledLaunch({
      projectId: project.id,
      taskId: body.taskId,
      actorUserId: user.id,
      idempotencyKey,
      scheduledLocalTime: body.scheduledLocalTime,
      timezone: body.timezone,
      disambiguation: body.disambiguation,
      launchRequest: body.launchRequest,
    });
    const intent = await getScheduledLaunchDto({
      projectId: project.id,
      scheduledLaunchId: created.intent.id,
    });

    if (!intent) {
      throw new MaisterError("CRASH", "scheduled launch could not be read");
    }
    log.info(
      { projectId: project.id, scheduledLaunchId: intent.id, actorId: user.id },
      "scheduled launch created",
    );

    return NextResponse.json(
      { intent },
      {
        status: created.replayed ? 200 : 201,
        headers: revisionHeaders(intent.revision),
      },
    );
  } catch (error) {
    return errorResponse(error, log, slug);
  }
}
