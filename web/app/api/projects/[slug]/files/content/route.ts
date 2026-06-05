import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { workbenchMaxFileBytes } from "@/lib/instance-config";
import { getProjectBySlug } from "@/lib/queries/project";
import { readBlob, repoRelPathSchema } from "@/lib/worktree";

const log = pino({
  name: "api-project-files-content",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string }> };

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 400;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
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

  log.error({ slug, err: message }, "GET /api/projects/[slug]/files/content");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    await requireActiveSession();

    const project = await getProjectBySlug(slug);

    if (!project || project.archivedAt) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(project.id, "readRepoFiles");

    const path = new URL(req.url).searchParams.get("path");

    if (!path) {
      throw new MaisterError("CONFIG", "path is required");
    }
    if (!repoRelPathSchema.safeParse(path).success) {
      throw new MaisterError("CONFIG", "invalid path");
    }

    const blob = await readBlob({
      repo: project.repoPath,
      ref: project.mainBranch,
      path,
      maxBytes: workbenchMaxFileBytes(),
    });

    switch (blob.kind) {
      case "not-found":
        return NextResponse.json({ message: "not found" }, { status: 404 });
      case "too-large":
        return NextResponse.json(
          { kind: "too-large", size: blob.size },
          { status: 413 },
        );
      case "binary":
        return NextResponse.json({ kind: "binary" }, { status: 415 });
      case "text":
        return NextResponse.json({ kind: "text", content: blob.content });
    }
  } catch (err) {
    return errorResponse(err, slug);
  }
}
