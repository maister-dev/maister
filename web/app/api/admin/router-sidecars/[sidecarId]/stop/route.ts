import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { stopSidecar } from "@/lib/supervisor-client";

const { platformRouterSidecars } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "api-admin-router-sidecar-stop",
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
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "router sidecar stop API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ sidecarId: string }> };

// ADR-093: admin-triggered CCR sidecar stop. Forwards to the supervisor
// per-instance stop (never the manager-wide shutdown) and returns the
// supervisor-reported process state. No DB idempotency marker.
export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { sidecarId } = await params;

  try {
    await requireGlobalRole("admin");

    const db = getDb() as any;
    const rows = await db
      .select()
      .from(platformRouterSidecars)
      .where(eq(platformRouterSidecars.id, sidecarId));

    if (!rows[0]) {
      throw new MaisterError(
        "PRECONDITION",
        `router sidecar not found: ${sidecarId}`,
      );
    }

    log.info({ sidecarId }, "router sidecar stop requested");

    const result = await stopSidecar(sidecarId);

    log.info({ sidecarId, state: result.state }, "router sidecar stop outcome");

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
