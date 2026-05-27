import "server-only";

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import pino from "pino";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { runFlow } from "@/lib/flows/runner";
import { tryStartRun } from "@/lib/scheduler";
import { addWorktree } from "@/lib/worktree";

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
  return process.env.MAISTER_WORKTREE_ROOT ?? path.join(tmpdir(), "maister-worktrees");
}

function resolveExecutor(args: {
  override: string | undefined;
  task: { executorOverrideId: string | null };
  project: { defaultExecutorId: string | null };
  flow: { recommendedExecutorId: string | null };
}): string {
  const id =
    args.override ??
    args.task.executorOverrideId ??
    args.project.defaultExecutorId ??
    args.flow.recommendedExecutorId;

  if (!id) {
    throw new MaisterError(
      "EXECUTOR_UNAVAILABLE",
      "no executor resolved (no override, task override, project default, or flow recommendation)",
    );
  }

  return id;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: z.infer<typeof postBodySchema>;

  try {
    body = postBodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(
      new MaisterError("CONFIG", `invalid POST body: ${(err as Error).message}`),
    );
  }

  try {
    const db = getDb() as unknown as {
      select: any;
      insert: any;
      update: any;
      transaction: any;
    };

    const taskRows = await db.select().from(tasks).where(eq(tasks.id, body.taskId));
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

    const flowRows = await db.select().from(flows).where(eq(flows.id, task.flowId));
    const flow = flowRows[0];

    if (!flow) {
      throw new MaisterError("PRECONDITION", "flow not found for task");
    }

    const executorId = resolveExecutor({
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
        branch,
        worktreePath,
      },
      "POST /api/runs preconditions ok",
    );

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

    try {
      await addWorktree({
        projectRepoPath: project.repoPath,
        branch,
        worktreePath,
      });
    } catch (err) {
      await db
        .update(workspaces)
        .set({ removedAt: new Date() })
        .where(eq(workspaces.runId, runId));
      await db
        .update(runs)
        .set({ status: "Failed", endedAt: new Date() })
        .where(eq(runs.id, runId));
      throw err;
    }

    const startResult = await tryStartRun(runId, { db });

    if (startResult.started) {
      void runFlow(runId, { worktreePath }).catch((err: unknown) =>
        log.error(
          { err: (err as Error).message, runId },
          "background runFlow failed",
        ),
      );

      return NextResponse.json(
        { runId, status: "Running" },
        { status: 202 },
      );
    }

    return NextResponse.json(
      { runId, status: "Pending", queuePosition: startResult.queuePosition },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
