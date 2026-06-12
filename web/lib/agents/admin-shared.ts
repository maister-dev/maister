import "server-only";

import { NextResponse } from "next/server";
import pino from "pino";

import { isMaisterError } from "@/lib/errors";

const log = pino({
  name: "api-admin-agents",
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
    case "CONFLICT":
    case "PRECONDITION":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

export function agentsErrorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { err: err instanceof Error ? err.message : String(err) },
    "agents admin API error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// Explicit DTO projection — never serialize the raw row (repo rule).
export function projectAgentSummary(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: row.id,
    flowRefId: row.flowRefId,
    versionLabel: row.versionLabel,
    origin: row.origin,
    name: row.name,
    description: row.description,
    runnerId: row.runnerId ?? null,
    workspace: row.workspace,
    workspaceRef: row.workspaceRef ?? null,
    mode: row.mode,
    triggers: row.triggers,
    riskTier: row.riskTier,
    recommended: row.recommended ?? null,
    sourcePath: row.sourcePath,
    enabled: row.enabled,
    quarantinedAt: row.quarantinedAt ?? null,
    quarantineReason: row.quarantineReason ?? null,
  };
}
