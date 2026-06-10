import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { dispatchScheduleNow } from "@/lib/run-schedules/dispatch";
import { getScheduleForProject } from "@/lib/run-schedules/service";

// FIXME(any): dual drizzle-orm peer-dep variants (matches app/api/runs/route.ts).
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-project-schedules",
  level: process.env.LOG_LEVEL ?? "info",
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

  log.error({ slug, err: message }, "schedule trigger route unhandled error");

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

    if (!schedule) {
      return NextResponse.json(
        { code: "NOT_FOUND", message: "schedule not found" },
        { status: 404 },
      );
    }

    const result = await dispatchScheduleNow(scheduleId, {
      actorUserId: user.id,
    });

    log.info(
      { slug, scheduleId, outcome: result.outcome, runId: result.runId },
      "schedule triggered",
    );

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, slug);
  }
}
