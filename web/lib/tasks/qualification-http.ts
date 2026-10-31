import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { and, eq } from "drizzle-orm";
import pino from "pino";
import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import { projects, tasks } from "@/lib/db/schema";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";

export async function requireTaskQualificationAccess(
  slug: string,
  taskId: string,
): Promise<{ db: Db; projectId: string; taskId: string; userId: string }> {
  const user = await requireActiveSession();
  const db = getDb();
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug));

  if (!project)
    throw new MaisterError(
      "PRECONDITION",
      "Task qualification is unavailable",
      { details: { reason: "qualification_not_found" } },
    );
  await requireProjectAction(project.id, "editTask");
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, project.id)));

  if (!task)
    throw new MaisterError(
      "PRECONDITION",
      "Task qualification is unavailable",
      { details: { reason: "qualification_not_found" } },
    );

  return { db, projectId: project.id, taskId: task.id, userId: user.id };
}

const log = pino({
  name: "task-qualification-http",
  level: process.env.LOG_LEVEL ?? "info",
});

export function taskQualificationErrorResponse(error: unknown): NextResponse {
  if (isMaisterError(error)) {
    const status =
      error.details?.reason === "qualification_not_found"
        ? 404
        : error.code === "UNAUTHENTICATED"
          ? 401
          : [
                "UNAUTHORIZED",
                "ACCOUNT_INACTIVE",
                "PASSWORD_CHANGE_REQUIRED",
              ].includes(error.code)
            ? 403
            : error.code === "CONFIG"
              ? 400
              : 409;

    log.warn(
      { code: error.code, reason: error.details?.reason ?? null, status },
      "task qualification request refused",
    );

    return NextResponse.json(
      { code: error.code, message: error.message },
      { status },
    );
  }

  log.error(
    { errorType: error instanceof Error ? error.name : "unknown" },
    "task qualification request failed",
  );

  return NextResponse.json(
    { code: "CRASH", message: "Task qualification could not be processed" },
    { status: 500 },
  );
}
