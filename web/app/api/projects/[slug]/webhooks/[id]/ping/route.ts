import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectRole } from "@/lib/authz";
import { getProjectBySlug } from "@/lib/queries/project";
import { isMaisterError } from "@/lib/errors";
import { pingSubscription } from "@/lib/webhooks/ping";
import { getSubscription } from "@/lib/webhooks/subscriptions";

const log = pino({
  name: "api-project-webhook-ping",
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
    "project webhook ping error",
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

// Auth-first, then resolve the URL slug to a project (server-state). Ping is a
// write (live signed POST) → member+.
async function resolveScope(
  slug: string,
): Promise<{ projectId: string } | NextResponse> {
  await requireActiveSession();

  const project = await getProjectBySlug(slug);

  if (!project || project.archivedAt) return projectNotFound(slug);

  await requireProjectRole(project.id, "member");

  return { projectId: project.id };
}

export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { slug, id } = await params;

  try {
    const scope = await resolveScope(slug);

    if (scope instanceof NextResponse) return scope;

    // Unknown subscription short-circuits before any ping send (404).
    const subscription = await getSubscription(scope, id);

    if (!subscription) return notFound(id);

    const result = await pingSubscription({
      subscription: {
        id: subscription.id,
        url: subscription.url,
        method: subscription.method,
        headers: subscription.headers,
        signingSecretRef: subscription.signing_secret_ref,
        secondarySigningSecretRef: subscription.secondary_signing_secret_ref,
      },
    });

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err, id);
  }
}
