import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { createTask } from "@/lib/services/tasks";

// FIXME(any): dual drizzle-orm peer-dep variants (matches app/api/runs/route.ts).
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-project-tasks",
  level: process.env.LOG_LEVEL ?? "info",
});

const postBodySchema = z
  .object({
    title: z.string().min(1),
    prompt: z.string().min(1),
    // M34 (ADR-089): optional — simple-intent creation; the task classifies
    // as `unconfigured` until triage (or a human) fills the flow.
    flowId: z.string().min(1).optional(),
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

  try {
    // Auth-first: authenticate AND clear the forced-password-change gate
    // BEFORE parsing the body or resolving the URL slug, so unauthenticated or
    // must-change callers cannot probe project existence or drive body parsing.
    // Project membership is enforced below.
    const user = await requireActiveSession();

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

    // Parse the body only after authz. Wrap a zod failure as CONFIG (422).
    let body: z.infer<typeof postBodySchema>;

    try {
      body = postBodySchema.parse(await req.json());
    } catch (err) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${(err as Error).message}`,
      );
    }

    const { taskId, number, taskKey } = await createTask(
      {
        title: body.title,
        prompt: body.prompt,
        flowId: body.flowId,
      },
      { projectId: project.id, actorUserId: user.id },
    );

    log.info({ slug, taskId, flowId: body.flowId }, "task created");

    return NextResponse.json({ taskId, number, taskKey }, { status: 201 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
