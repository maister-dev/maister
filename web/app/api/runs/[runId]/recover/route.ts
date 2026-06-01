import "server-only";

import type { RecoverResult } from "@/lib/runs/recover";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { resumeCrashedRun } from "@/lib/runs/recover";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants — Db handle.
type Db = any;

const log = pino({
  name: "api-run-recover",
  level: process.env.LOG_LEVEL ?? "info",
});

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, ctx: { runId: string }): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "recover error",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "recover unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

// Map the RecoverResult state → HTTP. The DTO NEVER carries acpSessionId or any
// session handle — only {ok, state, runStatus?}.
function statusForState(state: RecoverResult["state"]): number {
  switch (state) {
    case "resumed":
    case "redispatched":
      return 200;
    case "queued":
      return 202;
    case "discard-only":
    case "conflict":
      return 409;
    case "unresumable":
      return 410;
    case "transient":
      return 503;
  }
}

function runStatusForState(state: RecoverResult["state"]): string | undefined {
  switch (state) {
    case "resumed":
    case "redispatched":
      return "Running";
    case "queued":
      return "Pending";
    default:
      return undefined;
  }
}

type RouteParams = { params: Promise<{ runId: string }> };

export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as Db;
    const rows = await db
      .select({
        id: runs.id,
        projectId: runs.projectId,
        status: runs.status,
        acpSessionId: runs.acpSessionId,
        currentStepId: runs.currentStepId,
        runKind: runs.runKind,
      })
      .from(runs)
      .where(eq(runs.id, runId));
    const run = rows[0];

    if (!run) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `run not found: ${runId}` },
        { status: 404 },
      );
    }

    await requireProjectAction(run.projectId, "recoverRun");

    const r = await resumeCrashedRun(runId);
    const ok =
      r.state === "resumed" ||
      r.state === "redispatched" ||
      r.state === "queued";
    const runStatus = runStatusForState(r.state);

    log.info({ runId, state: r.state }, "recover handled");

    return NextResponse.json(
      { ok, state: r.state, ...(runStatus ? { runStatus } : {}) },
      { status: statusForState(r.state) },
    );
  } catch (err) {
    return errorResponse(err, { runId });
  }
}
