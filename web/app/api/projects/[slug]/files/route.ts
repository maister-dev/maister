import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";
import { listTree, repoRelPathSchema } from "@/lib/worktree";

const log = pino({
  name: "api-project-files",
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

  log.error({ slug, err: message }, "GET /api/projects/[slug]/files");

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

    const url = new URL(req.url);
    const path = url.searchParams.get("path") ?? "";
    // `ref` lets the project repo tab browse a branch other than the default;
    // listTree format-validates it via gitRefSchema and a missing ref → 404.
    const ref = url.searchParams.get("ref") || project.mainBranch;

    if (path !== "" && !repoRelPathSchema.safeParse(path).success) {
      throw new MaisterError("CONFIG", "invalid path");
    }

    const tree = await listTree({
      repo: project.repoPath,
      ref,
      dir: path,
    });

    if (tree === null) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    return NextResponse.json(tree);
  } catch (err) {
    return errorResponse(err, slug);
  }
}
