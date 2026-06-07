import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { searchMemberCandidates } from "@/lib/project-members";
import { getProjectBySlug } from "@/lib/queries/project";

const log = pino({
  name: "api-project-members",
  level: process.env.LOG_LEVEL ?? "info",
});

function statusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 422;
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
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { slug, err: err instanceof Error ? err.message : String(err) },
    "member candidates route unhandled error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ slug: string }> };

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug } = await params;

  try {
    // Auth-first: authenticate before resolving the slug so the candidate
    // search cannot be used to probe project existence unauthenticated.
    await requireActiveSession();

    const project = await getProjectBySlug(slug);

    if (!project || project.archivedAt) {
      throw new MaisterError("PRECONDITION", `project not found: ${slug}`);
    }

    await requireProjectAction(project.id, "manageMembers");

    const q = req.nextUrl.searchParams.get("q") ?? "";
    const candidates = await searchMemberCandidates(project.id, q);

    return NextResponse.json({ candidates });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
