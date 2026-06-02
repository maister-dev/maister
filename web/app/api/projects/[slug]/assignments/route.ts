import "server-only";

import type { NextRequest, NextResponse } from "next/server";
import type { Assignment } from "@/lib/db/schema";

import { eq } from "drizzle-orm";
import { NextResponse as Response } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { dtosForAssignments } from "@/app/api/assignments/[assignmentId]/_shared";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants — pg|sqlite union.
const { assignments, projects } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): route accepts both pg and sqlite drizzle clients.
type Db = any;
type RouteParams = { params: Promise<{ slug: string }> };

const log = pino({
  name: "api-project-assignments",
  level: process.env.LOG_LEVEL ?? "info",
});

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "PRECONDITION":
      return 404;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, slug: string): NextResponse {
  if (isMaisterError(err)) {
    return Response.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }

  const message = err instanceof Error ? err.message : String(err);

  log.error({ slug, err: message }, "GET project assignments unhandled error");

  return Response.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function loadProject(
  db: Db,
  slug: string,
): Promise<{ id: string; archivedAt: Date | null }> {
  const [project] = await db
    .select({ id: projects.id, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.slug, slug));

  if (!project || project.archivedAt !== null) {
    throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
  }

  return project;
}

export async function GET(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as Db;
    const project = await loadProject(db, slug);

    await requireProjectAction(project.id, "readBoard");

    const rows = (await db
      .select()
      .from(assignments)
      .where(eq(assignments.projectId, project.id))) as Assignment[];

    const dtos = await dtosForAssignments(db, rows);

    log.info(
      { slug, projectId: project.id, assignmentCount: dtos.length },
      "project assignments listed",
    );

    return Response.json({ assignments: dtos }, { status: 200 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
