import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import {
  dialogStatusAfterSupervisorStop,
  isTerminalScratchDialogStatus,
  runStatusForDialogStatus,
} from "@/lib/scratch-runs/state";
import { deleteSession } from "@/lib/supervisor-client";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, scratchRuns, workspaces } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "api-scratch-stop",
  level: process.env.LOG_LEVEL ?? "info",
});

type RouteParams = { params: Promise<{ runId: string }> };
// FIXME(any): route tests use a minimal drizzle-like fake DB.
type Db = {
  select: any;
  update: any;
  transaction: any;
};

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
    case "ACCOUNT_INACTIVE":
      return 403;
    case "CONFIG":
      return 400;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

function errorResponse(err: unknown, runId: string): NextResponse {
  if (isMaisterError(err)) {
    return NextResponse.json(
      { code: err.code, message: err.message },
      { status: httpStatusForCode(err.code) },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ runId, err: message }, "POST /api/scratch-runs/[runId]/stop");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function loadScratchLifecycleRows(db: Db, runId: string) {
  const runRows = await db.select().from(runs).where(eq(runs.id, runId));
  const run = runRows[0];

  if (!run) {
    throw new MaisterError("PRECONDITION", `run not found: ${runId}`);
  }
  if (run.runKind !== "scratch") {
    throw new MaisterError("PRECONDITION", `run is not scratch: ${runId}`);
  }

  const [scratchRows, workspaceRows] = await Promise.all([
    db.select().from(scratchRuns).where(eq(scratchRuns.runId, runId)),
    db.select().from(workspaces).where(eq(workspaces.runId, runId)),
  ]);
  const scratch = scratchRows[0];

  if (!scratch) {
    throw new MaisterError(
      "PRECONDITION",
      `scratch metadata not found: ${runId}`,
    );
  }

  return { run, scratch, workspace: workspaceRows[0] ?? null };
}

async function deleteSupervisorSessionIfLive(
  sessionId: string,
  runId: string,
): Promise<boolean> {
  try {
    await deleteSession(sessionId);

    return true;
  } catch (err) {
    if (
      isMaisterError(err) &&
      (err.code === "PRECONDITION" || err.code === "ACP_PROTOCOL") &&
      /unknown session|not found|404/i.test(err.message)
    ) {
      log.info(
        { runId, sessionId },
        "scratch stop treated missing supervisor session as already stopped",
      );

      return false;
    }

    throw err;
  }
}

export async function POST(
  _req: Request,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;

  try {
    await requireActiveSession();

    const db = getDb() as unknown as Db;
    const { run, scratch, workspace } = await loadScratchLifecycleRows(
      db,
      runId,
    );

    await requireProjectAction(run.projectId, "operateScratchRun");

    if (isTerminalScratchDialogStatus(scratch.dialogStatus)) {
      log.info(
        { runId, dialogStatus: scratch.dialogStatus },
        "scratch stop skipped terminal run",
      );

      return NextResponse.json({
        runId,
        dialogStatus: scratch.dialogStatus,
        runStatus: run.status,
        supervisorStopped: false,
        workspaceActive: Boolean(workspace && !workspace.removedAt),
      });
    }

    const activeWorkspace = Boolean(workspace && !workspace.removedAt);
    const nextDialogStatus = dialogStatusAfterSupervisorStop({
      hasWorkspace: activeWorkspace,
    });
    const nextRunStatus = runStatusForDialogStatus(nextDialogStatus);
    const now = new Date();
    let supervisorStopped = false;

    if (scratch.supervisorSessionId) {
      supervisorStopped = await deleteSupervisorSessionIfLive(
        scratch.supervisorSessionId,
        runId,
      );
    }

    await db.transaction(async (tx: Db) => {
      await tx
        .update(scratchRuns)
        .set({
          dialogStatus: nextDialogStatus,
          supervisorSessionId: null,
          updatedAt: now,
        })
        .where(eq(scratchRuns.runId, runId));
      await tx
        .update(runs)
        .set({
          status: nextRunStatus,
          acpSessionId: null,
          currentStepId: null,
          endedAt: now,
        })
        .where(eq(runs.id, runId));
    });

    return NextResponse.json({
      runId,
      dialogStatus: nextDialogStatus,
      runStatus: nextRunStatus,
      supervisorStopped,
      workspaceActive: activeWorkspace,
    });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
