import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectRole } from "@/lib/authz";
import { getProjectBySlug } from "@/lib/queries/project";
import { isMaisterError } from "@/lib/errors";
import { replayDelivery } from "@/lib/webhooks/replay";
import { deliveryBelongsToScopedSubscription } from "@/lib/webhooks/subscriptions";

const log = pino({
  name: "api-project-webhook-replay",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = {
  params: Promise<{ slug: string; id: string; deliveryId: string }>;
};

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

function errorResponse(err: unknown, deliveryId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { deliveryId, err: err instanceof Error ? err.message : String(err) },
    "project webhook replay error",
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

function notFound(deliveryId: string): NextResponse {
  return NextResponse.json(
    {
      code: "PRECONDITION",
      message: `webhook delivery not found: ${deliveryId}`,
    },
    { status: 404 },
  );
}

// Auth-first, then resolve the URL slug to a project (server-state). Replay is a
// write (re-queues a delivery) → member+.
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
  const { slug, id, deliveryId } = await params;

  try {
    const scope = await resolveScope(slug);

    if (scope instanceof NextResponse) return scope;

    // Server-state ownership join FIRST: a delivery that does not belong to
    // this subscription under this project (a cross-project / cross-sub /
    // platform row) is a 404 BEFORE replayDelivery runs — else replay.ts's
    // not-found CONFLICT would leak a miss as a 409.
    const owns = await deliveryBelongsToScopedSubscription(
      scope,
      id,
      deliveryId,
    );

    if (!owns) return notFound(deliveryId);

    await replayDelivery(deliveryId);

    log.info(
      { id, deliveryId, projectId: scope.projectId },
      "project webhook delivery replayed",
    );

    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (err) {
    return errorResponse(err, deliveryId);
  }
}
