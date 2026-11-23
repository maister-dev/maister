import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireProjectAction } from "@/lib/authz";
import { authorizeCompanyRunUserAction } from "@/lib/agents/company-run-read-access";
import { interactiveTaskLaunchPrincipal } from "@/lib/tasks/admission-types";
import { interactiveTaskLaunchRecoveryAuthority } from "@/lib/tasks/launch-continuation";
import {
  assertInteractiveLaunchOrigin,
  taskLaunchErrorResponse,
} from "@/lib/tasks/launch-http";
import { getDb } from "@/lib/db/client";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  restartFailedFlowNode,
  restartFailedFlowNodeFromCheckpoint,
  resumeCrashedRun,
} from "@/lib/runs/recover";
import { loadNodeRestartCheckpointPreview } from "@/lib/runs/node-restart-checkpoint";
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
    case "CHECKPOINT":
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
    const status =
      err.details?.reason === "run_unavailable"
        ? 404
        : httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "recover error",
    );

    return NextResponse.json(
      {
        code: err.code,
        message: err.message,
        ...(typeof err.details?.reason === "string" &&
        err.details.reason.startsWith("restart_checkpoint_")
          ? { details: { reason: err.details.reason } }
          : {}),
      },
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
const attemptIdPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await interactiveTaskLaunchPrincipal();
    const attemptId = request.nextUrl.searchParams.get("restartAttempt");

    if (!attemptId || !attemptIdPattern.test(attemptId))
      return NextResponse.json(
        { code: "PRECONDITION", message: "Invalid restart attempt ID" },
        { status: 400 },
      );
    const db = getDb();
    const [run] = await db
      .select({ projectId: runs.projectId, runKind: runs.runKind })
      .from(runs)
      .where(eq(runs.id, runId));

    if (!run?.projectId || run.runKind !== "flow")
      throw new MaisterError("PRECONDITION", "Project Flow not found", {
        details: { reason: "run_unavailable" },
      });
    await requireProjectAction(run.projectId, "recoverRun");
    await requireProjectAction(run.projectId, "readRepoFiles");
    const { preview } = await loadNodeRestartCheckpointPreview(
      db,
      runId,
      attemptId,
    );

    return NextResponse.json(preview, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error, { runId });
  }
}

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    const principal = await interactiveTaskLaunchPrincipal();

    assertInteractiveLaunchOrigin(request);
    const restartAttemptId = request.nextUrl.searchParams.get("restartAttempt");
    const checkpointToken =
      request.nextUrl.searchParams.get("restartCheckpoint");

    if (
      (restartAttemptId !== null && !attemptIdPattern.test(restartAttemptId)) ||
      (checkpointToken !== null &&
        (!restartAttemptId || !/^[a-f0-9]{64}$/.test(checkpointToken)))
    )
      return NextResponse.json(
        { code: "PRECONDITION", message: "Invalid restart attempt ID" },
        { status: 400 },
      );

    const db = getDb() as Db;
    const rows = await db
      .select({
        id: runs.id,
        companyId: runs.companyId,
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

    if (run.companyId !== null) {
      await authorizeCompanyRunUserAction(
        db,
        principal.userId,
        runId,
        "assignments:recover",
      );
      if (run.runKind !== "flow")
        return NextResponse.json(
          {
            code: "CONFLICT",
            message: "This company Run requires its own recovery action",
          },
          { status: 409 },
        );
    } else await requireProjectAction(run.projectId, "recoverRun");

    if (restartAttemptId && (run.companyId !== null || run.runKind !== "flow"))
      return NextResponse.json(
        { code: "CONFLICT", message: "Node restart requires a project Flow" },
        { status: 409 },
      );

    const opts = {
      ...(run.companyId !== null
        ? { companyRecoveryPrincipal: principal }
        : {
            recoveryAuthority:
              interactiveTaskLaunchRecoveryAuthority(principal),
          }),
    };
    if (checkpointToken)
      await requireProjectAction(run.projectId, "readRepoFiles");
    const r = !restartAttemptId
      ? await resumeCrashedRun(runId, opts)
      : checkpointToken
        ? await restartFailedFlowNodeFromCheckpoint(
            runId,
            restartAttemptId,
            checkpointToken,
            opts,
          )
        : await restartFailedFlowNode(runId, restartAttemptId, opts);

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
