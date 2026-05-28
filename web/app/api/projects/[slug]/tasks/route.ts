import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (matches app/api/runs/route.ts).
const { executors, flows, projects, tasks } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "api-project-tasks",
  level: process.env.LOG_LEVEL ?? "info",
});

const postBodySchema = z.object({
  title: z.string().min(1),
  prompt: z.string().min(1),
  flowId: z.string().min(1),
  executorOverrideId: z.string().min(1).optional(),
});

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "CONFIG":
      return 422;
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

  log.error({ slug, err: message }, "POST tasks unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ slug: string }> };

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
    const db = getDb() as unknown as { select: any; insert: any };

    // Resolve project from the URL slug (server-state) before authz — never
    // trust a body projectId.
    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    const project = projectRows[0];

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    await requireProjectAction(project.id, "createTask");

    // Validate flowId belongs to THIS project (body-controlled).
    const flowRows = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, body.flowId), eq(flows.projectId, project.id)));

    if (flowRows.length === 0) {
      throw new MaisterError(
        "CONFIG",
        `flow ${body.flowId} is not configured for project ${slug}`,
      );
    }

    // Validate executor override (when present) belongs to THIS project.
    if (body.executorOverrideId) {
      const executorRows = await db
        .select()
        .from(executors)
        .where(
          and(
            eq(executors.id, body.executorOverrideId),
            eq(executors.projectId, project.id),
          ),
        );

      if (executorRows.length === 0) {
        throw new MaisterError(
          "CONFIG",
          `executor ${body.executorOverrideId} is not registered for project ${slug}`,
        );
      }
    }

    const taskId = randomUUID();

    await db.insert(tasks).values({
      id: taskId,
      projectId: project.id,
      title: body.title,
      prompt: body.prompt,
      flowId: body.flowId,
      executorOverrideId: body.executorOverrideId ?? null,
      status: "Backlog",
      stage: "Backlog",
    });

    log.info({ slug, taskId, flowId: body.flowId }, "task created");

    return NextResponse.json({ taskId }, { status: 201 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
