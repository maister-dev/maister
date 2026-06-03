import "server-only";

import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import {
  createAssignment,
  ensureUserActor,
  findActiveAssignmentForRun,
  systemCloseActiveAssignmentsForRun,
} from "@/lib/assignments/service";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { assertEvidenceReady } from "@/lib/flows/graph/evidence-readiness";
import { gcAgeDays } from "@/lib/instance-config";
import { branchExists, promoteLocalMerge } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { runs, scratchRuns, workspaces } = schemaModule as unknown as Record<
  string,
  any
>;

const log = pino({
  name: "api-run-promote",
  level: process.env.LOG_LEVEL ?? "info",
});

const promoteBodySchema = z
  .object({
    mode: z.enum(["local_merge", "pull_request"]),
    targetBranch: z.string().min(1).max(255).optional(),
  })
  .strict();

type PromoteBody = z.infer<typeof promoteBodySchema>;
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

  log.error({ runId, err: message }, "POST /api/runs/[runId]/promote");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

async function loadScratchPromotionRows(db: Db, runId: string) {
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
  const workspace = workspaceRows[0];

  if (!scratch) {
    throw new MaisterError(
      "PRECONDITION",
      `scratch metadata not found: ${runId}`,
    );
  }
  if (!workspace) {
    throw new MaisterError("PRECONDITION", `workspace not found: ${runId}`);
  }
  if (workspace.removedAt) {
    throw new MaisterError(
      "PRECONDITION",
      `workspace already removed for run: ${runId}`,
    );
  }
  if (scratch.dialogStatus !== "Review") {
    throw new MaisterError(
      "PRECONDITION",
      `scratch run must be Review before promotion: ${scratch.dialogStatus}`,
    );
  }

  return { run, scratch, workspace };
}

function targetBranchFor(body: PromoteBody, scratch: any): string {
  return body.targetBranch ?? scratch.baseBranch;
}

function assertPromotionTargetAllowed(
  scratch: any,
  targetBranch: string,
): void {
  if (targetBranch !== scratch.baseBranch) {
    throw new MaisterError(
      "PRECONDITION",
      `promotion target branch is outside project policy: ${targetBranch}`,
    );
  }
}

async function createMergeConflictAssignment(args: {
  db: Db;
  run: any;
  workspace: any;
  sessionUser: { id: string; name?: string | null; email?: string | null };
  targetBranch: string;
}): Promise<void> {
  const existing = await findActiveAssignmentForRun({
    db: args.db,
    runId: args.run.id,
    actionKinds: ["merge_conflict"],
  });

  if (existing !== null) {
    log.info(
      {
        runId: args.run.id,
        projectId: args.run.projectId,
        assignmentId: existing.id,
        targetBranch: args.targetBranch,
      },
      "[FIX:M13] merge-conflict assignment already active",
    );

    return;
  }

  const actor = await ensureUserActor({
    db: args.db,
    projectId: args.run.projectId,
    userId: args.sessionUser.id,
    label:
      args.sessionUser.name ?? args.sessionUser.email ?? args.sessionUser.id,
  });

  await createAssignment({
    db: args.db,
    projectId: args.run.projectId,
    runId: args.run.id,
    taskId: args.run.taskId ?? null,
    actionKind: "merge_conflict",
    roleRefs: [],
    title: `Resolve merge conflict into ${args.targetBranch}`,
    createdByActorId: actor.id,
    branch: args.workspace.branch,
    ref: args.targetBranch,
  });

  log.info(
    {
      runId: args.run.id,
      projectId: args.run.projectId,
      actorId: actor.id,
      branch: args.workspace.branch,
      targetBranch: args.targetBranch,
    },
    "[FIX:M13] merge-conflict assignment created",
  );
}

export async function POST(
  req: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const { runId } = await params;
  let body: PromoteBody;

  try {
    body = promoteBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid POST body: ${(err as Error).message}`,
      ),
      runId,
    );
  }

  try {
    const sessionUser = await requireActiveSession();

    if (body.mode === "pull_request") {
      throw new MaisterError(
        "CONFIG",
        "pull_request promotion is designed but not implemented in this build",
      );
    }

    const db = getDb() as unknown as Db;
    const { run, scratch, workspace } = await loadScratchPromotionRows(
      db,
      runId,
    );

    await requireProjectAction(run.projectId, "promoteRun");

    const targetBranch = targetBranchFor(body, scratch);

    assertPromotionTargetAllowed(scratch, targetBranch);

    const readiness = await assertEvidenceReady(runId, "merge", db);

    if (!readiness.ready) {
      throw new MaisterError(
        "PRECONDITION",
        `merge refused: evidence not ready — ${readiness.reasons.join("; ")}`,
      );
    }

    const targetExists = await branchExists({
      projectRepoPath: workspace.parentRepoPath,
      branch: targetBranch,
    });

    if (!targetExists) {
      throw new MaisterError(
        "PRECONDITION",
        `promotion target branch does not exist: ${targetBranch}`,
      );
    }

    let commit: string;

    try {
      commit = await promoteLocalMerge({
        projectRepoPath: workspace.parentRepoPath,
        sourceBranch: workspace.branch,
        targetBranch,
      });
    } catch (err) {
      if (isMaisterError(err) && err.code === "CONFLICT") {
        await createMergeConflictAssignment({
          db,
          run,
          workspace,
          sessionUser,
          targetBranch,
        });
      }

      throw err;
    }
    const now = new Date();

    // M19 Phase 1 (T1.C): parity with the Abandoned path — stamp the GC
    // removal deadline (endedAt + gcAgeDays()) on the run's workspace in the
    // SAME tx as the Done flip so a promoted run is GC-eligible.
    const scheduledRemovalAt = new Date(
      now.getTime() + gcAgeDays() * 86_400_000,
    );

    await db.transaction(async (tx: Db) => {
      await tx
        .update(scratchRuns)
        .set({
          dialogStatus: "Done",
          targetBranch,
          supervisorSessionId: null,
          updatedAt: now,
        })
        .where(eq(scratchRuns.runId, runId));
      await tx
        .update(runs)
        .set({
          status: "Done",
          acpSessionId: null,
          currentStepId: null,
          endedAt: now,
        })
        .where(eq(runs.id, runId));
      await tx
        .update(workspaces)
        .set({ scheduledRemovalAt })
        .where(eq(workspaces.runId, runId));
      await systemCloseActiveAssignmentsForRun({
        db: tx,
        runId,
        reason: "run promoted to Done",
      });
    });

    return NextResponse.json({
      ok: true,
      mode: "local_merge",
      commit,
      pullRequestUrl: null,
    });
  } catch (err) {
    return errorResponse(err, runId);
  }
}
