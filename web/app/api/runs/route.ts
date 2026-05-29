import "server-only";

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { requireActiveSession, requireProjectAction } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { resolveExecutor } from "@/lib/executors";
import { runFlow } from "@/lib/flows/runner";
import { tryStartRun } from "@/lib/scheduler";
import { addWorktree, removeWorktree } from "@/lib/worktree";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { executors, flows, projects, runs, tasks, workspaces } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "api-runs",
  level: process.env.LOG_LEVEL ?? "info",
});

const postBodySchema = z.object({
  taskId: z.string().min(1),
  executorOverrideId: z.string().min(1).optional(),
});

function errorResponse(err: unknown): NextResponse {
  if (isMaisterError(err)) {
    const status = httpStatusForCode(err.code);

    return NextResponse.json(
      { code: err.code, message: err.message },
      { status },
    );
  }
  const message = err instanceof Error ? err.message : String(err);

  log.error({ err: message }, "POST /api/runs unhandled error");

  return NextResponse.json(
    { code: "CRASH", message: "internal error" },
    { status: 500 },
  );
}

function httpStatusForCode(code: string): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "UNAUTHORIZED":
    case "PASSWORD_CHANGE_REQUIRED":
      return 403;
    case "PRECONDITION":
    case "CONFLICT":
      return 409;
    case "EXECUTOR_UNAVAILABLE":
      return 503;
    case "CONFIG":
      return 400;
    default:
      return 500;
  }
}

function resolveWorktreeRoot(): string {
  return (
    process.env.MAISTER_WORKTREE_ROOT ??
    path.join(tmpdir(), "maister-worktrees")
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: z.infer<typeof postBodySchema>;

  try {
    body = postBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError(
        "CONFIG",
        `invalid POST body: ${(err as Error).message}`,
      ),
    );
  }

  try {
    // Auth-first: authenticate AND clear the forced-password-change gate up
    // front, so must-change callers cannot probe task/project existence before
    // auth. Project-role authz happens once projectId is derived from the task
    // row below (taskId is body-controlled — never trust a body projectId).
    await requireActiveSession();

    // FIXME(any): dual drizzle-orm peer-dep variants — pg|sqlite union.
    const db = getDb() as unknown as {
      select: any;
      insert: any;
      update: any;
      transaction: any;
    };

    const taskRows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, body.taskId));
    const task = taskRows[0];

    if (!task) {
      throw new MaisterError("PRECONDITION", `task not found: ${body.taskId}`);
    }
    if (task.status !== "Backlog") {
      throw new MaisterError(
        "PRECONDITION",
        `task is not in Backlog (got ${task.status})`,
      );
    }

    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.id, task.projectId));
    const project = projectRows[0];

    if (!project) {
      throw new MaisterError("PRECONDITION", "project not found for task");
    }
    if (project.archivedAt) {
      throw new MaisterError("PRECONDITION", "project is archived");
    }

    await requireProjectAction(project.id, "launchRun");

    const flowRows = await db
      .select()
      .from(flows)
      .where(eq(flows.id, task.flowId));
    const flow = flowRows[0];

    if (!flow) {
      throw new MaisterError("PRECONDITION", "flow not found for task");
    }

    const { executorId, tier: resolvedFromTier } = resolveExecutor({
      override: body.executorOverrideId,
      task,
      project,
      flow,
    });

    const executorRows = await db
      .select()
      .from(executors)
      .where(
        and(eq(executors.id, executorId), eq(executors.projectId, project.id)),
      );
    const executor = executorRows[0];

    if (!executor) {
      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        `executor ${executorId} not registered for project ${project.slug}`,
      );
    }

    const newAttempt = task.attemptNumber + 1;
    const branch = `${project.branchPrefix}task-${task.id}/attempt-${newAttempt}`;
    const worktreeRoot = resolveWorktreeRoot();
    const runId = randomUUID();
    const worktreePath = path.join(worktreeRoot, project.slug, runId);

    log.info(
      {
        taskId: task.id,
        runId,
        executorId: executor.id,
        resolvedFromTier,
        branch,
        worktreePath,
      },
      "POST /api/runs preconditions ok",
    );

    // Create the worktree BEFORE the DB transaction so a git failure
    // (branch already exists, dirty parent repo, missing path) does
    // NOT leave the task stuck in InFlight with an orphan run/workspace
    // row. The task stays in Backlog and is launchable again.
    await addWorktree({
      projectRepoPath: project.repoPath,
      branch,
      worktreePath,
    });

    try {
      await db.transaction(async (tx: any) => {
        await tx.insert(workspaces).values({
          id: randomUUID(),
          runId,
          projectId: project.id,
          branch,
          worktreePath,
          parentRepoPath: project.repoPath,
        });
        await tx.insert(runs).values({
          id: runId,
          taskId: task.id,
          projectId: project.id,
          flowId: flow.id,
          executorId: executor.id,
          status: "Pending",
          flowVersion: flow.version,
          // Snapshot the SHA so the runner can derive the immutable
          // bundle path from `(flowRefId, flowRevision)`. A later flow
          // upgrade mutates `flows.revision` but `runs.flow_revision`
          // remains pinned to the version this run launched against.
          flowRevision: flow.revision,
        });
        await tx
          .update(tasks)
          .set({
            status: "InFlight",
            attemptNumber: newAttempt,
            updatedAt: new Date(),
          })
          .where(eq(tasks.id, task.id));
      });
    } catch (err) {
      // DB transaction rolled back. Compensate: remove the orphan worktree
      // so the next launch can recreate the same branch+path without a
      // PRECONDITION "already exists" failure.
      log.warn(
        { runId, err: (err as Error).message },
        "DB transaction failed after addWorktree — removing worktree",
      );
      await removeWorktree({
        projectRepoPath: project.repoPath,
        worktreePath,
        force: true,
      }).catch((rmErr) =>
        log.error(
          { rmErr: (rmErr as Error).message, worktreePath },
          "compensating removeWorktree failed (manual cleanup may be required)",
        ),
      );
      throw err;
    }

    const startResult = await tryStartRun(runId, { db });

    if (startResult.started) {
      void runFlow(runId).catch((err: unknown) =>
        log.error(
          { err: (err as Error).message, runId },
          "background runFlow failed",
        ),
      );

      return NextResponse.json({ runId, status: "Running" }, { status: 202 });
    }

    return NextResponse.json(
      { runId, status: "Pending", queuePosition: startResult.queuePosition },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
