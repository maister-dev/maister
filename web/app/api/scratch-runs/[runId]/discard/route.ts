import "server-only";

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import pino from "pino";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { preserveWorktree } from "@/lib/gc/preserve";
import { worktreesRoot } from "@/lib/instance-config";
import { assertLocalPackageAssistantActor } from "@/lib/scratch-runs/service";
import { cleanupLocalPackageAssistantMaterialization } from "@/lib/scratch-runs/local-package-materialization";
import { deleteSession } from "@/lib/supervisor-client";
import { removeOwnedWorktree } from "@/lib/worktree";
import { stopThenDrop } from "@/lib/workbench-lifecycle/service";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { localPackages, runs, scratchRuns, workspaces } =
  schemaModule as unknown as Record<string, any>;

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
        "scratch discard treated missing supervisor session as already stopped",
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
    const sessionUser = await requireActiveSession();

    const db = getDb() as unknown as Db;
    const { run, scratch, workspace } = await loadScratchLifecycleRows(
      db,
      runId,
    );

    // ADR-097: a project scratch run keeps its project-scoped gate; a
    // project-less local-package assistant run (project_id NULL) is private to
    // its launching user — gate on created_by_user_id (the same dual-authz
    // branch the GET/recover/stream routes use). requireLock:false so the user
    // can drop their own run even after the editor lock has lapsed.
    if (run.projectId) {
      await requireProjectAction(run.projectId, "operateScratchRun");
    } else {
      await assertLocalPackageAssistantActor(run, sessionUser.id, {
        requireLock: false,
      });
    }

    if (scratch.dialogStatus === "Done" || run.status === "Done") {
      log.info(
        { runId, dialogStatus: scratch.dialogStatus, runStatus: run.status },
        "scratch discard skipped completed run",
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
        "scratch discard idempotent abandoned run",
      );

      return NextResponse.json({
        runId,
        dialogStatus: scratch.dialogStatus,
        runStatus: run.status,
        supervisorStopped: false,
        workspaceRemoved: false,
      });
    }

    if (run.projectId && workspace && !workspace.removedAt) {
      const result = await stopThenDrop(runId);

      return NextResponse.json({
        ...result,
        dialogStatus: result.runStatus === "Done" ? "Done" : "Abandoned",
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

    const shouldRemoveWorkspace = Boolean(workspace && !workspace.removedAt);

    let removalResult:
      | {
          archivedAt: Date;
          archivedBranch: string | null;
          archivedCommit: string | null;
          preservationOutcome:
            | "not_needed"
            | "ref_created"
            | "snapshot_created";
        }
      | undefined;

    if (shouldRemoveWorkspace && workspace) {
      const preserved = await preserveWorktree({
        worktreePath: workspace.worktreePath,
        parentRepoPath: workspace.parentRepoPath,
        branch: workspace.branch,
        baseRef: workspace.baseCommit ?? workspace.baseBranch ?? "main",
        runId,
      });

      if (!preserved.ok) {
        throw new MaisterError(
          "CONFLICT",
          `could not preserve scratch worktree before discard: ${runId}`,
        );
      }

      await removeOwnedWorktree({
        projectRepoPath: workspace.parentRepoPath,
        worktreePath: workspace.worktreePath,
        allowedRoot: worktreesRoot(),
        force: true,
      });

      removalResult = {
        archivedAt: preserved.archivedAt ?? new Date(),
        archivedBranch: preserved.archivedBranch ?? workspace.archivedBranch,
        archivedCommit: preserved.archivedCommit ?? null,
        preservationOutcome:
          preserved.preservationOutcome ??
          (preserved.snapshotted ? "snapshot_created" : "not_needed"),
      };
      workspaceRemoved = true;
    }

    const now = new Date();

    await db.transaction(async (tx: Db) => {
      if (shouldRemoveWorkspace && workspace && removalResult) {
        await tx
          .update(workspaces)
          .set({
            removedAt: now,
            archivedAt: removalResult.archivedAt,
            archivedBranch: removalResult.archivedBranch,
            archivedCommit: removalResult.archivedCommit,
            preservationOutcome: removalResult.preservationOutcome,
            removalKind: "discard",
          })
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
          currentStepId: null,
          endedAt: now,
        })
        .where(eq(runs.id, runId));
    });

    if (run.localPackageId) {
      const packageRows = await db
        .select({ workingDir: localPackages.workingDir })
        .from(localPackages)
        .where(eq(localPackages.id, run.localPackageId));
      const localPackage = packageRows[0];

      if (!localPackage) {
        log.error(
          { runId, localPackageId: run.localPackageId },
          "local-package scratch discard could not resolve materialization root",
        );
      } else {
        const cleanup = await cleanupLocalPackageAssistantMaterialization({
          workingDir: localPackage.workingDir,
          runId,
        });

        if (!cleanup.released || !cleanup.capabilityRootRemoved) {
          log.error(
            {
              runId,
              workingDir: localPackage.workingDir,
              ...cleanup,
            },
            "local-package scratch discard left materialization for a later retry",
          );
        }
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
