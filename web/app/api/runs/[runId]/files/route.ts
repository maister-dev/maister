import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { getRunDetail } from "@/lib/queries/run";
import { listTree, repoRelPathSchema } from "@/lib/worktree";

const log = pino({
  name: "api-run-files",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };

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

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ runId, err: message }, "GET /api/runs/[runId]/files");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const detail = await getRunDetail(runId);

    if (!detail) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    await requireProjectAction(detail.projectId, "readRepoFiles");

    const path = new URL(req.url).searchParams.get("path") ?? "";

    if (path !== "" && !repoRelPathSchema.safeParse(path).success) {
      throw new MaisterError("CONFIG", "invalid path");
    }

    const tree = await listTree({
      repo: detail.worktreePath,
      ref: detail.branch,
      dir: path,
    });

    if (tree === null) {
      return NextResponse.json({ message: "not found" }, { status: 404 });
    }

    return NextResponse.json(tree);
  } catch (err) {
    return errorResponse(err, runId);
  }
}
