import "server-only";

import { NextRequest, NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { isMaisterError } from "@/lib/errors";
import { loadRunProjectId } from "@/lib/flows/graph/runner-core";
import { escalateNodeInterrupt } from "@/lib/runs/node-interrupt";
import { loadActiveRunSession } from "@/lib/runs/active-run-session";
import { executionHosts } from "@/lib/execution-host";

// FIXME(any): dual drizzle-orm peer-dep variants — Db handle.
type Db = any;

const log = pino({
  name: "api-node-interrupt",
  level: process.env.LOG_LEVEL ?? "info",
});

// node-interrupt: 202 / 401 / 403 / 404 / 409 / 503. No new MaisterError code
// (ADR-008): an unmet admission term → PRECONDITION; a CAS lost to the node's
// own completion → CONFLICT; an undeliverable checkpoint → EXECUTOR_UNAVAILABLE.
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
    case "CONFIG":
      return 400;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, ctx: { runId: string }): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    log.warn(
      { ...ctx, code: err.code, message: err.message, status },
      "node interrupt refused",
    );

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ ...ctx, err: message }, "node interrupt unhandled error");

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
    // Auth-first. The body is EMPTY — the node, its attempt, and the supervisor
    // session are all server-state.
    const user = await requireActiveSession();

    const db = getDb() as Db;
    const projectId = await loadRunProjectId(db, runId);

    if (!projectId) {
      return NextResponse.json(
        { code: "PRECONDITION", message: `run not found: ${runId}` },
        { status: 404 },
      );
    }

    await requireProjectAction(projectId, "answerHitl");

    // The live session is looked up by the server-owned runId, never taken from
    // a body field. `loadActiveRunSession` already prefers a row with a live
    // `acp_session_id`; the checkpoint addresses the host's own session id
    // (ADR-166) through the client bound to the run's active assignment.
    const session = await loadActiveRunSession(db, runId);
    const sessionId = session?.hostSessionId ?? null;

    if (!sessionId) {
      return NextResponse.json(
        {
          code: "PRECONDITION",
          message: `run ${runId} has no live agent session to interrupt`,
        },
        { status: 409 },
      );
    }

    const client = await executionHosts.forRun(runId);
    const result = await escalateNodeInterrupt({
      db,
      runId,
      actorUserId: user.id,
      supervisorSessionId: sessionId,
      checkpointSession: (id) => client.checkpoint(id),
    });

    return NextResponse.json(
      {
        ok: true,
        runStatus: "NeedsInput",
        hitlRequestId: result.hitlRequestId,
      },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err, { runId });
  }
}
