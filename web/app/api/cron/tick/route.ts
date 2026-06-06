import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { authorizeCronRequest } from "@/lib/scheduler/cron-auth";
import { isSchedulerJobKind } from "@/lib/scheduler/jobs";
import { runSchedulerTick } from "@/lib/scheduler/tick-service";

const log = pino({
  name: "cron-tick",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = authorizeCronRequest(req);

  if (!auth.ok) {
    log.warn({ status: auth.status }, "scheduler tick auth failed");

    return NextResponse.json(auth.body, { status: auth.status });
  }

  const rawJobKind = req.nextUrl.searchParams.get("jobKind");

  if (rawJobKind !== null && !isSchedulerJobKind(rawJobKind)) {
    return NextResponse.json(
      {
        code: "VALIDATION",
        message: `unknown scheduler jobKind: ${rawJobKind}`,
      },
      { status: 422 },
    );
  }

  const summary = await runSchedulerTick({
    jobKind: rawJobKind ?? undefined,
  });
  const status =
    summary.failedCount > 0 || summary.skippedCount > 0 ? 207 : 200;

  log.info({ ...summary, status }, "scheduler tick route completed");

  return NextResponse.json(summary, { status });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
