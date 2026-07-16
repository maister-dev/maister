import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { authorizeCronRequest } from "@/lib/scheduler/cron-auth";
import { requestSystemSweep } from "@/lib/scheduler/tick-service";

const log = pino({
  name: "cron-gc",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = authorizeCronRequest(req);

  if (!auth.ok) {
    return NextResponse.json(auth.body, { status: auth.status });
  }

  const summary = await requestSystemSweep();

  log.info(
    {
      ...summary,
      source: "cron-gc-compat",
      failedCount: summary.failedCount,
    },
    "cron GC sweep requested through scheduler",
  );

  return NextResponse.json(summary, {
    status:
      summary.failedCount > 0 ? 207 : summary.claimedCount === 0 ? 202 : 200,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
