import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { replayDelivery } from "@/lib/webhooks/replay";
import { deliveryBelongsToScopedSubscription } from "@/lib/webhooks/subscriptions";

const log = pino({
  name: "api-admin-webhook-replay",
  level: process.env.LOG_LEVEL ?? "info",
});

const PLATFORM_SCOPE = { projectId: null } as const;

type RouteParams = { params: Promise<{ id: string; deliveryId: string }> };

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
    "admin webhook replay error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
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

export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { id, deliveryId } = await params;

  try {
    await requireGlobalRole("admin");

    // Server-state ownership join FIRST: a delivery that does not belong to
    // this subscription (or scope) is a 404 BEFORE replayDelivery runs — else
    // replay.ts's not-found CONFLICT would leak a cross-sub miss as a 409.
    const owns = await deliveryBelongsToScopedSubscription(
      PLATFORM_SCOPE,
      id,
      deliveryId,
    );

    if (!owns) return notFound(deliveryId);

    await replayDelivery(deliveryId);

    log.info({ id, deliveryId }, "platform webhook delivery replayed");

    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (err) {
    return errorResponse(err, deliveryId);
  }
}
