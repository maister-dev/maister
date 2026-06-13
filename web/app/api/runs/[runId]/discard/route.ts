import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { systemCloseActiveAssignmentsForRun } from "@/lib/assignments/service";
import { finalizeAgentRun } from "@/lib/agents/launch";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { markAbandoned } from "@/lib/runs/state-transitions";
import { promoteNextPending } from "@/lib/scheduler";
import * as schemaModule from "@/lib/db/schema";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants — Db handle.
type Db = any;

const log = pino({
  name: "api-run-discard",
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
      "discard error",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "discard unhandled error");

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

    await requireProjectAction(run.projectId, "recoverRun");

    // Discard = terminal abandon. markAbandoned stamps workspaces
    // .scheduled_removal_at in the SAME tx (GC countdown); NO synchronous
    // worktree removal here.
    const res =
      run.runKind === "agent"
        ? await finalizeAgentRun(runId, "Abandoned", {
            db,
            reason: "discard",
            closeAssignments: {
              kind: "system",
              reason: "run discarded",
            },
          }).then((result) => ({ ok: result.finalized }))
        : await markAbandoned(runId, { db });

    if (res.ok) {
      if (run.runKind !== "agent") {
        await systemCloseActiveAssignmentsForRun({
          db,
          runId,
          reason: "run discarded",
        });
      }

      if (run.runKind !== "agent") {
        // The just-abandoned run freed a slot — promote the oldest Pending. Lazy
        // scheduler defaults resume/launch the promoted run.
        try {
          await promoteNextPending({ db });
        } catch (err) {
          log.error(
            { runId, err: err instanceof Error ? err.message : String(err) },
            "promoteNextPending after discard failed (non-fatal)",
          );
        }
      }

      log.info({ runId, from: run.status }, "run discarded");

      return NextResponse.json(
        { ok: true, runStatus: "Abandoned" },
        { status: 200 },
      );
    }

    // CAS lost — already terminal. Idempotent when already Abandoned.
    const reloadRows = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId));

    if (reloadRows[0]?.status === "Abandoned") {
      return NextResponse.json(
        { ok: true, runStatus: "Abandoned" },
        { status: 200 },
      );
    }

    return NextResponse.json(
      {
        code: "CONFLICT",
        message: `run ${runId} is not in a discardable state`,
      },
      { status: 409 },
    );
  } catch (err) {
    return errorResponse(err, { runId });
  }
}
