import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { getAdapterSupportById } from "@/lib/acp-runners/adapter-support";
import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getProjectCapabilityCatalog } from "@/lib/capabilities/catalog";
import { isMaisterError } from "@/lib/errors";
import { getProjectBySlug } from "@/lib/queries/project";

const log = pino({
  name: "api-capability-catalog",
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
  log.error(
    { slug, err: err instanceof Error ? err.message : String(err) },
    "GET /api/projects/[slug]/capability-catalog",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// GET /api/projects/[slug]/capability-catalog?agent=<id> — Designed (FR-B2):
// the unified static autocomplete catalog (skills ∪ claude-only subagents) for
// the composer, per the requested runner. Viewer-gated; project from slug.
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

    await requireProjectAction(project.id, "readBoard");

    const agentParam = new URL(req.url).searchParams.get("agent") ?? "claude";
    const agent = getAdapterSupportById(agentParam)?.id ?? "claude";
    const capabilities = await getProjectCapabilityCatalog(project.id, agent);

    return NextResponse.json({ capabilities });
  } catch (err) {
    return errorResponse(err, slug);
  }
}
