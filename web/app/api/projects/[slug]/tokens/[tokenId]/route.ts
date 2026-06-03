import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { revokeToken } from "@/lib/tokens/revoke";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { projects } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-project-tokens-id",
  level: process.env.LOG_LEVEL ?? "info",
});

function httpStatusForAuthz(code: string): number {
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
      { status: httpStatusForAuthz(err.code) },
    );
  }

  const message = err instanceof Error ? err.message : String(err);

  log.error({ slug, err: message }, "tokens/[tokenId] route unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ slug: string; tokenId: string }> };

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, tokenId } = await params;

  try {
    await requireActiveSession();
    const db = getDb() as unknown as { select: any };

    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.slug, slug));
    const project = projectRows[0];

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    await requireProjectAction(project.id, "editSettings");

    const { outcome } = await revokeToken({ tokenId, projectId: project.id });

    if (outcome === "not-found") {
      return NextResponse.json(
        { code: "NOT_FOUND", message: "token not found" },
        { status: 404 },
      );
    }

    // "revoked" and "already-revoked" both return 204 (idempotent).
    log.info({ slug, tokenId, outcome }, "token revoked");

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
