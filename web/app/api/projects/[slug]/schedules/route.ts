import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  getProjectScheduleDTO,
  listProjectSchedules,
} from "@/lib/run-schedules/queries";
import { createSchedule } from "@/lib/run-schedules/service";

// FIXME(any): dual drizzle-orm peer-dep variants (matches app/api/runs/route.ts).
const { projects } = schemaModule as unknown as Record<string, any>;

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

  log.error({ slug, err: message }, "schedules route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
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
    return errorResponse(err, slug);
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
    return errorResponse(err, slug);
  }
}
