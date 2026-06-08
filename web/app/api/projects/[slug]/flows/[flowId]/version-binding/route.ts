import "server-only";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (matches app/api/runs/route.ts).
const { flows, projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-flows-version-binding",
  level: process.env.LOG_LEVEL ?? "info",
});

const patchBodySchema = z.object({
  binding: z.enum(["pinned", "latest"]),
});

type RouteParams = { params: Promise<{ slug: string; flowId: string }> };

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
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "FLOW_INSTALL":
      return 502;
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

  log.error(
    { slug, err: message },
    "flows version-binding route unhandled error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// Toggle version_binding for a flow in this project.
// Identifiers: slug + flowId are url-params resolved to server state.
// RBAC: requires managePackages (admin) on the project.
export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, flowId } = await params;

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
    await requireActiveSession();

    const db = getDb() as any;

    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    const project = projectRows[0];

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    await requireProjectAction(project.id, "managePackages");

    const flowRows = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, flowId), eq(flows.projectId, project.id)));
    const flow = flowRows[0];

    if (!flow) {
      return NextResponse.json(
        { code: "NOT_FOUND", message: `flow not found: ${flowId}` },
        { status: 404 },
      );
    }

    await db
      .update(flows)
      .set({ versionBinding: body.binding })
      .where(and(eq(flows.id, flowId), eq(flows.projectId, project.id)));

    log.debug(
      { projectId: project.id, flowId, binding: body.binding },
      "flows version_binding toggled",
    );

    return NextResponse.json({ ok: true, versionBinding: body.binding });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
