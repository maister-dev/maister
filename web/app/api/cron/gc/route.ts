import "server-only";

import { timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { runRevisionGcSweep } from "@/lib/gc/revision-gc";
import { runWorkspaceGcSweep } from "@/lib/gc/workspace-gc";

const log = pino({
  name: "cron-gc",
  level: process.env.LOG_LEVEL ?? "info",
});

const CRON_TOKEN_HEADER = "X-Maister-Cron-Token";

// Constant-time token compare. Length mismatch makes timingSafeEqual throw, so
// guard it and return false (a mismatch). Never log or echo the token.
function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  try {
    const a = new TextEncoder().encode(provided);
    const b = new TextEncoder().encode(expected);

    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const token = process.env.MAISTER_CRON_TOKEN;

  if (!token) {
    return NextResponse.json({ error: "cron disabled" }, { status: 503 });
  }

  if (!tokenMatches(req.headers.get(CRON_TOKEN_HEADER), token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Both sweeps run INDEPENDENTLY — each in its own try/catch so one throwing
  // does not abort the other. Both ok → 200; either threw → 207 (partial).
  let failed = false;
  let workspace: unknown;
  let revision: unknown;

  try {
    workspace = await runWorkspaceGcSweep();
  } catch (err) {
    failed = true;
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "cron GC: workspace sweep threw",
    );
    workspace = { error: "workspace sweep failed" };
  }

  try {
    revision = await runRevisionGcSweep();
  } catch (err) {
    failed = true;
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "cron GC: revision sweep threw",
    );
    revision = { error: "revision sweep failed" };
  }

  return NextResponse.json(
    { workspace, revision },
    { status: failed ? 207 : 200 },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return GET(req);
}
