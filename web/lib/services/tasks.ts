import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

// FIXME(any): dual drizzle-orm peer-dep variants (matches app/api/projects/[slug]/tasks/route.ts).
const { executors, flows, runs, tasks } = schemaModule as unknown as Record<
  string,
  any
>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "service-tasks",
  level: process.env.LOG_LEVEL ?? "info",
});

export type CreateTaskInput = {
  title: string;
  prompt: string;
  flowId: string;
  executorOverrideId?: string;
};

export type CreateTaskContext = {
  projectId: string;
  actorUserId?: string | null;
};

export async function createTask(
  input: CreateTaskInput,
  ctx: CreateTaskContext,
  db?: Db,
): Promise<{ taskId: string }> {
  const _db = (db ?? getDb()) as unknown as { select: any; insert: any };

  // Validate flowId belongs to THIS project (body-controlled).
  const flowRows = await _db
    .select()
    .from(flows)
    .where(and(eq(flows.id, input.flowId), eq(flows.projectId, ctx.projectId)));

  if (flowRows.length === 0) {
    throw new MaisterError(
      "CONFIG",
      `flow ${input.flowId} is not configured for project`,
    );
  }

  // Validate executor override (when present) belongs to THIS project.
  if (input.executorOverrideId) {
    const executorRows = await _db
      .select()
      .from(executors)
      .where(
        and(
          eq(executors.id, input.executorOverrideId),
          eq(executors.projectId, ctx.projectId),
        ),
      );

    if (executorRows.length === 0) {
      throw new MaisterError(
        "CONFIG",
        `executor ${input.executorOverrideId} is not registered for project`,
      );
    }
  }

  const taskId = randomUUID();

  await _db.insert(tasks).values({
    id: taskId,
    projectId: ctx.projectId,
    title: input.title,
    prompt: input.prompt,
    flowId: input.flowId,
    executorOverrideId: input.executorOverrideId ?? null,
    status: "Backlog",
    stage: "Backlog",
  });

  log.info(
    { projectId: ctx.projectId, taskId, flowId: input.flowId },
    "task created",
  );

  return { taskId };
}

export type TaskDTO = {
  id: string;
  title: string;
  prompt: string;
  status: string;
  stage: string;
  flowId: string;
  executorOverrideId: string | null;
  latestRunId: string | null;
  attemptNumber: number;
  createdAt: Date;
};

async function taskToDTO(row: any, db: { select: any }): Promise<TaskDTO> {
  // Derive the latest run for this task (most recent by startedAt).
  const runRows = await (db as any)
    .select({ id: runs.id })
    .from(runs)
    // co-filter by projectId (defence-in-depth: a run can only belong to its
    // task's project, but never derive a cross-project run id from a task DTO).
    .where(and(eq(runs.taskId, row.id), eq(runs.projectId, row.projectId)))
    .orderBy(desc(runs.startedAt))
    .limit(1);

  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    stage: row.stage,
    flowId: row.flowId,
    executorOverrideId: row.executorOverrideId ?? null,
    latestRunId: runRows[0]?.id ?? null,
    attemptNumber: row.attemptNumber,
    createdAt: row.createdAt,
  };
}

export async function getTaskDTO(
  taskId: string,
  projectId: string,
  db?: Db,
): Promise<TaskDTO | null> {
  const _db = (db ?? getDb()) as unknown as { select: any };
  const rows = await (_db as any)
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));

  if (rows.length === 0) return null;

  return taskToDTO(rows[0], _db);
}

export async function listTaskDTOs(
  projectId: string,
  db?: Db,
): Promise<TaskDTO[]> {
  const _db = (db ?? getDb()) as unknown as { select: any };
  const rows = await (_db as any)
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(desc(tasks.createdAt));

  return Promise.all(rows.map((r: any) => taskToDTO(r, _db)));
}

export type UpdateTaskInput = {
  title?: string;
  prompt?: string;
  executorOverrideId?: string | null;
};

export async function updateTask(
  taskId: string,
  projectId: string,
  input: UpdateTaskInput,
  db?: Db,
): Promise<TaskDTO> {
  const _db = (db ?? getDb()) as unknown as { select: any; update: any };
  const rows = await (_db as any)
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));

  if (rows.length === 0) {
    throw new MaisterError("PRECONDITION", `task not found: ${taskId}`);
  }

  const task = rows[0];

  if (task.status !== "Backlog") {
    throw new MaisterError(
      "PRECONDITION",
      `task is not in Backlog (got ${task.status})`,
    );
  }

  // Validate executorOverrideId belongs to the project when provided.
  if (
    input.executorOverrideId !== undefined &&
    input.executorOverrideId !== null
  ) {
    const executorRows = await (_db as any)
      .select()
      .from(executors)
      .where(
        and(
          eq(executors.id, input.executorOverrideId),
          eq(executors.projectId, projectId),
        ),
      );

    if (executorRows.length === 0) {
      throw new MaisterError(
        "CONFIG",
        `executor ${input.executorOverrideId} is not registered for project`,
      );
    }
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (input.title !== undefined) patch.title = input.title;
  if (input.prompt !== undefined) patch.prompt = input.prompt;
  if ("executorOverrideId" in input)
    patch.executorOverrideId = input.executorOverrideId ?? null;

  await (_db as any)
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));

  const updatedRows = await (_db as any)
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));

  return taskToDTO(updatedRows[0], _db);
}
