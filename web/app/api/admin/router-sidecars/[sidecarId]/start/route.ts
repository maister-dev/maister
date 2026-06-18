import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { startSidecar } from "@/lib/supervisor-client";

const { platformRouterSidecars } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "api-admin-router-sidecar-start",
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
    "router sidecar start API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ sidecarId: string }> };

// ADR-094: admin-triggered CCR sidecar start. Loads the sidecar from DB,
// forwards its config to the supervisor, and returns the supervisor-reported
// process state. No DB idempotency marker — process state is owned by the
// supervisor (the route is a proxy).
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
    const sidecar = rows[0];

    if (!sidecar) {
      throw new MaisterError(
        "PRECONDITION",
        `router sidecar not found: ${sidecarId}`,
      );
    }

    log.info({ sidecarId }, "router sidecar start requested");

    const result = await startSidecar(sidecarId, {
      lifecycle: sidecar.lifecycle,
      configPath: sidecar.configPath,
      baseUrl: sidecar.baseUrl,
      healthcheckUrl: sidecar.healthcheckUrl,
    });

    log.info(
      { sidecarId, state: result.state },
      "router sidecar start outcome",
    );

    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
