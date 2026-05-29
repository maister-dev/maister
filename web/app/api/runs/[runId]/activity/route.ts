import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { bumpKeepalive } from "@/lib/runs/state-transitions";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-activity",
  level: process.env.LOG_LEVEL ?? "info",
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TERMINAL_STATUSES = new Set([
  "Done",
  "Abandoned",
  "Failed",
  "Crashed",
  "Review",
]);

type RouteParams = { params: Promise<{ runId: string }> };

// M8 T7 / D6 identifier table:
//   runId  → URL path     (`url-param`, UUID v4 validated)
//   body   → request body (optional {kind?:"activity"}; NO cross-resource ids)
//
// Behaviour:
//   Running | NeedsInput → bumpKeepalive → 204
//   NeedsInputIdle       → 409 with {nextAction:"respond"}
//   terminal             → 410
//   missing run / bad uuid → 400 / 404
//
// Activity does NOT auto-resume idle runs by design: that would conflate
// "I am paying attention to this review" with "I have something to say
// about it" and could starve the cap of operator-driven HITL responses.
// The /respond route is the only resume entry point (D8/T10).
export async function POST(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  if (!UUID_RE.test(runId)) {
    log.debug({ runId }, "activity: invalid uuid");

    return NextResponse.json(
      { code: "PRECONDITION", message: "runId must be a UUID" },
      { status: 400 },
    );
  }

  const db = getDb() as any;
  const rows = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId));
  const row = rows[0];

  if (!row) {
    log.debug({ runId }, "activity: unknown run");

    return NextResponse.json(
      { code: "PRECONDITION", message: "unknown run" },
      { status: 404 },
    );
  }

  if (row.status === "NeedsInputIdle") {
    log.debug(
      { runId, status: row.status },
      "activity: idle run — caller must use /respond",
    );

    return NextResponse.json(
      {
        code: "PRECONDITION",
        message: "run is checkpointed; submit a HITL response to resume",
        nextAction: "respond",
      },
      { status: 409 },
    );
  }

  if (TERMINAL_STATUSES.has(row.status)) {
    log.debug({ runId, status: row.status }, "activity: terminal run");

    return NextResponse.json(
      { code: "PRECONDITION", message: `run is ${row.status}` },
      { status: 410 },
    );
  }

  if (row.status !== "Running" && row.status !== "NeedsInput") {
    // Pending or any other status: activity has no effect (no
    // keepalive_until window to bump). Treat as 409 — caller's
    // assumption that a session is live is wrong.
    log.debug({ runId, status: row.status }, "activity: status not bumpable");

    return NextResponse.json(
      { code: "PRECONDITION", message: `cannot bump status=${row.status}` },
      { status: 409 },
    );
  }

  const r = await bumpKeepalive(runId, { db });

  if (!r.ok) {
    log.debug({ runId }, "activity: bump status-guard race lost");

    return NextResponse.json(
      { code: "PRECONDITION", message: "status changed concurrently" },
      { status: 409 },
    );
  }

  log.debug({ runId, status: row.status }, "activity: keepalive bumped");

  return new NextResponse(null, { status: 204 });
}
