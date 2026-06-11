import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError } from "@/lib/errors";
import { getSubscription, listDeliveries } from "@/lib/webhooks/subscriptions";

const log = pino({
  name: "api-admin-webhook-deliveries",
  level: process.env.LOG_LEVEL ?? "info",
});

const PLATFORM_SCOPE = { projectId: null } as const;

type RouteParams = { params: Promise<{ id: string }> };

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
    "admin webhook deliveries error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function notFound(id: string): NextResponse {
  return NextResponse.json(
    { code: "PRECONDITION", message: `webhook subscription not found: ${id}` },
    { status: 404 },
  );
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { id } = await params;

  try {
    await requireGlobalRole("admin");

    // Scope-confined ownership check before any delivery read (404 on miss).
    const subscription = await getSubscription(PLATFORM_SCOPE, id);

    if (!subscription) return notFound(id);

    const url = new URL(req.url);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

    const page = await listDeliveries(PLATFORM_SCOPE, id, {
      cursor,
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    return NextResponse.json(page);
  } catch (err) {
    return errorResponse(err, id);
  }
}
