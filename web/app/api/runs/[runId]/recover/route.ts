import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireProjectAction } from "@/lib/authz";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { interactiveTaskLaunchRecoveryAuthority } from "@/lib/tasks/launch-continuation";
import {
  assertInteractiveLaunchOrigin,
  taskLaunchErrorResponse,
} from "@/lib/tasks/launch-http";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { resumeCrashedRun } from "@/lib/runs/recover";
import { recoverHttpResponse } from "@/lib/runs/recover-http";
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
    if (
      err.details?.reason === "launch_interactive_origin_required" ||
      err.details?.reason === "launch_origin_configuration_invalid"
    )
      return taskLaunchErrorResponse(err);
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

type RouteParams = { params: Promise<{ runId: string }> };

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    const principal = await interactiveTaskLaunchPrincipal();

    assertInteractiveLaunchOrigin(request);
    const db = getDb() as Db;
    const rows = await db
      .select({
        id: runs.id,
        projectId: runs.projectId,
        status: runs.status,
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

    const r = await resumeCrashedRun(runId, {
      recoveryAuthority: interactiveTaskLaunchRecoveryAuthority(principal),
    });

    log.info({ runId, state: r.state }, "recover handled");

    const { httpStatus, body } = recoverHttpResponse(r);

    if ("code" in body) {
      log.warn({ runId, state: r.state, code: body.code }, "recover refused");
    }

    return NextResponse.json(body, { status: httpStatus });
  } catch (err) {
    return errorResponse(err, { runId });
  }
}
