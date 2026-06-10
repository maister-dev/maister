import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import {
  errorResponse,
  notFoundResponse,
  resolveProject,
} from "@/lib/api/project-route-helpers";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { MaisterError } from "@/lib/errors";
import { getProjectScheduleDTO } from "@/lib/run-schedules/queries";
import { deleteSchedule, updateSchedule } from "@/lib/run-schedules/service";

const log = pino({
  name: "api-project-schedules",
  level: process.env.LOG_LEVEL ?? "info",
});

const patchBodySchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    cronExpr: z.string().min(1).max(100).optional(),
    timezone: z.string().min(1).optional(),
    overlapPolicy: z.enum(["skip", "queue_one", "start_anyway"]).optional(),
    runnerId: z.string().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "empty PATCH body",
  });

type RouteParams = { params: Promise<{ slug: string; scheduleId: string }> };

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, scheduleId } = await params;

  let body: z.infer<typeof patchBodySchema>;

  try {
    body = patchBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${(err as Error).message}`,
      ),
      log,
      slug,
    );
  }

  try {
    const user = await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageSchedules");

    const updated = await updateSchedule(project.id, scheduleId, body, {
      actorUserId: user.id,
    });

    if (!updated) return notFoundResponse("schedule not found");

    const schedule = await getProjectScheduleDTO(project.id, scheduleId);

    log.info({ slug, scheduleId }, "schedule updated");

    return NextResponse.json({ schedule });
  } catch (err) {
    return errorResponse(err, log, slug);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, scheduleId } = await params;

  try {
    const user = await requireActiveSession();
    const project = await resolveProject(slug);

    await requireProjectAction(project.id, "manageSchedules");

    const deleted = await deleteSchedule(project.id, scheduleId, {
      actorUserId: user.id,
    });

    if (!deleted) return notFoundResponse("schedule not found");

    log.info({ slug, scheduleId }, "schedule deleted");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, log, slug);
  }
}
