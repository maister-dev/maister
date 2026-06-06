import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireGlobalRole } from "@/lib/authz";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { listSchedulerStatusRows } from "@/lib/queries/scheduler";
import { createSchedulerJob } from "@/lib/scheduler/job-admin";
import { createSchedulerJobSchema } from "@/lib/scheduler/job-admin-schema";

const log = pino({
  name: "api-admin-scheduler-jobs",
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
    "scheduler jobs admin API error",
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

export async function GET(): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const jobs = await listSchedulerStatusRows({ limit: 200 });

    return NextResponse.json({ jobs });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireGlobalRole("admin");

    const body = await parseJson(req);
    const parsed = createSchedulerJobSchema.safeParse(body);

    if (!parsed.success) {
      throw new MaisterError(
        "CONFIG",
        `invalid POST body: ${parsed.error.message}`,
      );
    }

    const result = await createSchedulerJob({
      id: parsed.data.id,
      jobKind: parsed.data.jobKind,
      target: parsed.data.target,
      cadenceIntervalSeconds: parsed.data.cadenceIntervalSeconds,
      maxFailures: parsed.data.maxFailures,
      nextRunAt: parsed.data.nextRunAt
        ? new Date(parsed.data.nextRunAt)
        : undefined,
      projectId: parsed.data.projectId ?? null,
    });

    return NextResponse.json({ ok: true, id: result.id }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
