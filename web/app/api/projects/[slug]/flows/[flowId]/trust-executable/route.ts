import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { trustExecutable } from "@/lib/flows/exec-trust";

// FIXME(any): dual drizzle-orm peer-dep variants (matches version-binding route).
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-flows-trust-executable",
  level: process.env.LOG_LEVEL ?? "info",
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

  log.error({ slug, err: message }, "trust-executable route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// Flip exec_trust='trusted' for the enabled revision of a flow in this project
// and run any pending setup.sh. Idempotent.
// RBAC: requires managePackages (admin) on the project.
export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, flowId } = await params;

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

    log.debug({ projectId: project.id, flowId }, "trust-executable POST");

    const result = await trustExecutable({
      projectId: project.id,
      flowId,
      db,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
