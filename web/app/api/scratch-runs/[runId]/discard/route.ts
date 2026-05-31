import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { worktreesRoot } from "@/lib/instance-config";
import { deleteSession } from "@/lib/supervisor-client";
import { removeOwnedWorktree } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, scratchRuns, workspaces } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "api-scratch-discard",
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

  log.error({ runId, err: message }, "POST /api/scratch-runs/[runId]/discard");

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
        "[FIX] scratch discard treated missing supervisor session as already stopped",
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

    if (scratch.dialogStatus === "Done" || run.status === "Done") {
      log.info(
        { runId, dialogStatus: scratch.dialogStatus, runStatus: run.status },
        "[FIX] scratch discard skipped completed run",
      );

      return NextResponse.json({
        runId,
        dialogStatus: scratch.dialogStatus,
        runStatus: run.status,
        supervisorStopped: false,
        workspaceRemoved: false,
      });
    }

    if (scratch.dialogStatus === "Abandoned" || run.status === "Abandoned") {
      log.info(
        { runId, dialogStatus: scratch.dialogStatus, runStatus: run.status },
        "[FIX] scratch discard idempotent abandoned run",
      );

      return NextResponse.json({
        runId,
        dialogStatus: scratch.dialogStatus,
        runStatus: run.status,
        supervisorStopped: false,
        workspaceRemoved: false,
      });
    }

    let supervisorStopped = false;
    let workspaceRemoved = false;

    if (scratch.supervisorSessionId) {
      supervisorStopped = await deleteSupervisorSessionIfLive(
        scratch.supervisorSessionId,
        runId,
      );
    }

    const now = new Date();
    const shouldRemoveWorkspace = Boolean(workspace && !workspace.removedAt);

    await db.transaction(async (tx: Db) => {
      if (shouldRemoveWorkspace && workspace) {
        await tx
          .update(workspaces)
          .set({ removedAt: now })
          .where(eq(workspaces.id, workspace.id));
      }
      await tx
        .update(scratchRuns)
        .set({
          dialogStatus: "Abandoned",
          supervisorSessionId: null,
          updatedAt: now,
        })
        .where(eq(scratchRuns.runId, runId));
      await tx
        .update(runs)
        .set({
          status: "Abandoned",
          acpSessionId: null,
          currentStepId: null,
          endedAt: now,
        })
        .where(eq(runs.id, runId));
    });

    if (shouldRemoveWorkspace && workspace) {
      try {
        await removeOwnedWorktree({
          projectRepoPath: workspace.parentRepoPath,
          worktreePath: workspace.worktreePath,
          allowedRoot: worktreesRoot(),
          force: true,
        });
        workspaceRemoved = true;
      } catch (err) {
        log.error(
          {
            runId,
            workspaceId: workspace.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "scratch discard marked abandoned but worktree removal failed",
        );
      }
    }

    return NextResponse.json({
      runId,
      dialogStatus: "Abandoned",
      runStatus: "Abandoned",
      supervisorStopped,
      workspaceRemoved,
    });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
