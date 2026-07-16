import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  isWorkspaceReconciliationFindingState,
  listWorkspaceReconciliationFindings,
} from "@/lib/queries/workspace-reconciliation-findings";

const log = pino({
  name: "api-admin-workspace-reconciliation-findings",
  level: process.env.LOG_LEVEL ?? "info",
});

function errorStatus(error: MaisterError): number {
  switch (error.code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 400;
    default:
      return 500;
  }
}

function parseLimit(value: string | null): number {
  if (value === null) return 50;

  if (!/^\d+$/u.test(value)) {
    throw new MaisterError("CONFIG", "limit must be an integer between 1 and 100");
  }

  const limit = Number(value);

  if (limit < 1 || limit > 100) {
    throw new MaisterError("CONFIG", "limit must be between 1 and 100");
  }

  return limit;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");
    const state = request.nextUrl.searchParams.get("state");

    if (state !== null && !isWorkspaceReconciliationFindingState(state)) {
      throw new MaisterError("CONFIG", "invalid workspace reconciliation state");
    }

    const result = await listWorkspaceReconciliationFindings({
      state: state ?? undefined,
      cursor: request.nextUrl.searchParams.get("cursor") ?? undefined,
      limit: parseLimit(request.nextUrl.searchParams.get("limit")),
    });

    return NextResponse.json(result);
  } catch (error) {
    if (isMaisterError(error)) {
      return NextResponse.json(
        { code: error.code, message: error.message },
        { status: errorStatus(error) },
      );
    }

    log.error(
      { errorType: error instanceof Error ? error.name : "unknown" },
      "workspace reconciliation findings read failed",
    );
    return NextResponse.json(
      { code: "CRASH", message: "internal error" },
      { status: 500 },
    );
  }
}
