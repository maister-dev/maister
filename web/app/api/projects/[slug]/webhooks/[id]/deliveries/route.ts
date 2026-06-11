import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectRole } from "@/lib/authz";
import { getProjectBySlug } from "@/lib/queries/project";
import { isMaisterError } from "@/lib/errors";
import { getSubscription, listDeliveries } from "@/lib/webhooks/subscriptions";

const log = pino({
  name: "api-project-webhook-deliveries",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ slug: string; id: string }> };

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

function errorResponse(err: unknown, id: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { id, err: err instanceof Error ? err.message : String(err) },
    "project webhook deliveries error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function projectNotFound(slug: string): NextResponse {
  return NextResponse.json(
    { code: "PRECONDITION", message: `project not found: ${slug}` },
    { status: 404 },
  );
}

function notFound(id: string): NextResponse {
  return NextResponse.json(
    { code: "PRECONDITION", message: `webhook subscription not found: ${id}` },
    { status: 404 },
  );
}

// Auth-first, then resolve the URL slug to a project (server-state). Reads
// require any project member (viewer+).
async function resolveScope(
  slug: string,
): Promise<{ projectId: string } | NextResponse> {
  await requireActiveSession();

  const project = await getProjectBySlug(slug);

  if (!project || project.archivedAt) return projectNotFound(slug);

  await requireProjectRole(project.id, "viewer");

  return { projectId: project.id };
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, id } = await params;

  try {
    const scope = await resolveScope(slug);

    if (scope instanceof NextResponse) return scope;

    // Scope-confined ownership check before any delivery read (404 on miss).
    const subscription = await getSubscription(scope, id);

    if (!subscription) return notFound(id);

    const url = new URL(req.url);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

    const page = await listDeliveries(scope, id, {
      cursor,
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    return NextResponse.json(page);
  } catch (err) {
    return errorResponse(err, id);
  }
}
