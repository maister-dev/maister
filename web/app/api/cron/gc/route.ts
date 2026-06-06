import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { authorizeCronRequest } from "@/lib/scheduler/cron-auth";
import { runGcCompatibilitySweep } from "@/lib/scheduler/system-sweeps";

const log = pino({
  name: "cron-gc",
  level: process.env.LOG_LEVEL ?? "info",
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = authorizeCronRequest(req);

  if (!auth.ok) {
    return NextResponse.json(auth.body, { status: auth.status });
  }

  const summary = await runGcCompatibilitySweep();

  log.info(
    { ...summary, source: "cron-gc-compat", errorCount: summary.errors.length },
    "cron GC sweep completed",
  );

  return NextResponse.json(summary, {
    status: summary.errors.length > 0 ? 207 : 200,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
