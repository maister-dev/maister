import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import {
  errorResponse,
  notFoundResponse,
  resolveProject,
} from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { dispatchScheduleNow } from "@/lib/run-schedules/dispatch";
import { getScheduleForProject } from "@/lib/run-schedules/service";

const log = pino({
  name: "api-project-schedules",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string; scheduleId: string }> };

export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, scheduleId } = await params;

  try {
    const user = await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageSchedules");

    const schedule = await getScheduleForProject(project.id, scheduleId);

    if (!schedule) return notFoundResponse("schedule not found");

    const result = await dispatchScheduleNow(scheduleId, {
      actorUserId: user.id,
    });

    log.info(
      { slug, scheduleId, outcome: result.outcome, runId: result.runId },
      "schedule triggered",
    );

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, log, slug);
  }
}
