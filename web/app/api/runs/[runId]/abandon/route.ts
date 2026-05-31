import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { runFlow } from "@/lib/flows/runner";
import { promoteNextPending } from "@/lib/scheduler";
import {
  markAbandoned,
  releaseHumanWorking,
} from "@/lib/runs/state-transitions";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants — Db handle.
type Db = any;

const log = pino({
  name: "api-run-abandon",
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
      "abandon error",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "abandon unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

type RouteParams = { params: Promise<{ runId: string }> };

export async function POST(
  _req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    // Auth-first.
    await requireActiveSession();

    const db = getDb() as Db;
    const rows = await db.select().from(runs).where(eq(runs.id, runId));
    const run = rows[0];

    if (!run) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `run not found: ${runId}` },
        { status: 404 },
      );
    }

    await requireProjectAction(run.projectId, "answerHitl");

    // A HumanWorking run releases its takeover claim first (HumanWorking →
    // NeedsInput) so the standard abandon transition fires from a known
    // non-terminal status; the original review HITL re-opening is moot once the
    // run is abandoned.
    if (run.status === "HumanWorking") {
      await releaseHumanWorking(runId, { db });
    }

    const abandoned = await markAbandoned(runId, { db });

    if (!abandoned.ok) {
      return NextResponse.json(
        {
          code: "PRECONDITION",
          message: `run ${runId} is not in an abandonable state`,
        },
        { status: 409 },
      );
    }

    // A claimed/running slot just freed — promote the next queued Pending run.
    try {
      await promoteNextPending({
        db,
        runFlow: (next: string) => void runFlow(next, { db }),
      });
    } catch (err) {
      log.error(
        { runId, err: err instanceof Error ? err.message : String(err) },
        "promoteNextPending after abandon failed (non-fatal)",
      );
    }

    log.info({ runId, from: run.status }, "run abandoned");

    return NextResponse.json(
      { ok: true, runStatus: "Abandoned" },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err, { runId });
  }
}
