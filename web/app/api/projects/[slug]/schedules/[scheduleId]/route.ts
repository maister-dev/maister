import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { getProjectScheduleDTO } from "@/lib/run-schedules/queries";
import { deleteSchedule, updateSchedule } from "@/lib/run-schedules/service";

// FIXME(any): dual drizzle-orm peer-dep variants (matches app/api/runs/route.ts).
const { projects } = schemaModule as unknown as Record<string, any>;

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

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "CONFIG":
      return 400;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, slug: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ slug, err: message }, "schedule item route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function notFoundResponse(): NextResponse {
  return NextResponse.json(
    { code: "NOT_FOUND", message: "schedule not found" },
    { status: 404 },
  );
}

async function resolveProject(slug: string): Promise<{ id: string }> {
  const db = getDb() as unknown as { select: any };
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug));
  const project = projectRows[0];

  if (!project || project.archivedAt) {
    throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
  }

  return project;
}

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

    if (!updated) return notFoundResponse();

    const schedule = await getProjectScheduleDTO(project.id, scheduleId);

    log.info({ slug, scheduleId }, "schedule updated");

    return NextResponse.json({ schedule });
  } catch (err) {
    return errorResponse(err, slug);
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

    if (!deleted) return notFoundResponse();

    log.info({ slug, scheduleId }, "schedule deleted");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
