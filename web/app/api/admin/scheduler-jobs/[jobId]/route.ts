import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  deleteSchedulerJob,
  updateSchedulerJob,
} from "@/lib/scheduler/job-admin";
import { updateSchedulerJobSchema } from "@/lib/scheduler/job-admin-schema";

const log = pino({
  name: "api-admin-scheduler-job",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ jobId: string }> };

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

function errorResponse(err: unknown, jobId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: statusForCode(err.code) },
    );
  }

  log.error(
    { jobId, err: err instanceof Error ? err.message : String(err) },
    "scheduler job admin mutation error",
  );

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function parseJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch (err) {
    throw new MaisterError(
      "CONFIG",
      `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { jobId } = await params;

  try {
    await requireGlobalRole("admin");

    const body = await parseJson(req);
    const parsed = updateSchedulerJobSchema.safeParse(body);

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid PATCH body: ${parsed.error.message}`,
      );
    }

    await updateSchedulerJob(jobId, {
      target: parsed.data.target,
      cadenceIntervalSeconds: parsed.data.cadenceIntervalSeconds,
      maxFailures: parsed.data.maxFailures,
      nextRunAt: parsed.data.nextRunAt
        ? new Date(parsed.data.nextRunAt)
        : undefined,
      enabled: parsed.data.enabled,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, jobId);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { jobId } = await params;

  try {
    await requireGlobalRole("admin");
    await deleteSchedulerJob(jobId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, jobId);
  }
}
