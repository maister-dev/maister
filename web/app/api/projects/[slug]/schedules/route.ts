import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { errorResponse, resolveProject } from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import {
  getProjectScheduleDTO,
  listProjectSchedules,
} from "@/lib/run-schedules/queries";
import { createSchedule } from "@/lib/run-schedules/service";

const log = pino({
  name: "api-project-schedules",
  level: process.env.LOG_LEVEL ?? "info",
});

const postBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    taskId: z.string().min(1),
    cronExpr: z.string().min(1).max(100),
    timezone: z.string().min(1),
    overlapPolicy: z.enum(["skip", "queue_one", "start_anyway"]).optional(),
    runnerId: z.string().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ slug: string }> };

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    // Auth-first: authenticate before resolving the URL slug so callers
    // cannot probe project existence unauthenticated.
    await requireActiveSession();

    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "readBoard");

    const schedules = await listProjectSchedules(project.id);

    return NextResponse.json({ schedules });
  } catch (err) {
    return errorResponse(err, log, slug);
  }
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  let body: z.infer<typeof postBodySchema>;

  try {
    body = postBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid POST body: ${(err as Error).message}`,
      ),
      log,
      slug,
    );
  }

  try {
    const user = await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageSchedules");

    const created = await createSchedule({
      projectId: project.id,
      taskId: body.taskId,
      name: body.name,
      cronExpr: body.cronExpr,
      timezone: body.timezone,
      overlapPolicy: body.overlapPolicy,
      runnerId: body.runnerId,
      enabled: body.enabled,
      actorUserId: user.id,
    });
    const schedule = await getProjectScheduleDTO(project.id, created.id);

    log.info(
      { slug, scheduleId: created.id, taskId: body.taskId },
      "schedule created",
    );

    return NextResponse.json({ schedule }, { status: 201 });
  } catch (err) {
    return errorResponse(err, log, slug);
  }
}
