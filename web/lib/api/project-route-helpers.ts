import "server-only";

import type { Logger } from "pino";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (matches app/api/runs/route.ts).
const { projects } = schemaModule as unknown as Record<string, any>;

export function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
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

export function errorResponse(
  err: unknown,
  log: Logger,
  slug: string,
): NextResponse {
  if (isMaisterError(err)) {
    // `details` (ADR-093, additive) is forwarded only when the thrower set it —
    // e.g. the commit gate's `{ invalidArtifacts: [{ path, message }] }`. It is
    // client-facing context, NEVER a server-only handle (throwers redact).
    return NextResponse.json(
      err.details
        ? { code: err.code, message: err.message, details: err.details }
        : { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ slug, err: message }, "route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export function notFoundResponse(message: string): NextResponse {
  return NextResponse.json({ code: "NOT_FOUND", message }, { status: 404 });
}

export async function resolveProject(slug: string): Promise<{ id: string }> {
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
