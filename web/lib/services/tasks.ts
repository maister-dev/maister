import "server-only";

import type { ExecutionPolicy } from "@/lib/runs/execution-policy";

import { randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { emitDomainEvent } from "@/lib/domain-events/outbox";
import { MaisterError } from "@/lib/errors";
import { actorForUserId, recordTaskActivity } from "@/lib/social/activity";
import {
  validateVerdictRefs,
  type PromotionMode,
  type TaskVerdictPatch,
} from "@/lib/services/triage";
import { subscribe } from "@/lib/social/subscriptions";

// FIXME(any): dual drizzle-orm peer-dep variants (matches app/api/projects/[slug]/tasks/route.ts).
const { flows, projects, runs, tasks } = schemaModule as unknown as Record<
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
  // M34 (ADR-089): optional — a flowless task is a simple-intent task that
  // classifies as `unconfigured` until triage (or a human) fills the flow.
  flowId?: string | null;
};

export type CreateTaskContext = {
  projectId: string;
  actorUserId?: string | null;
};

export async function createTask(
  input: CreateTaskInput,
  ctx: CreateTaskContext,
  db?: Db,
): Promise<{ taskId: string; number: number; taskKey: string }> {
  const _db = (db ?? getDb()) as unknown as {
    select: any;
    insert: any;
    transaction: any;
  };

  const flowId = input.flowId ?? null;

  // Validate flowId belongs to THIS project (body-controlled) when provided.
  if (flowId !== null) {
    const flowRows = await _db
      .select()
      .from(flows)
      .where(and(eq(flows.id, flowId), eq(flows.projectId, ctx.projectId)));

    if (flowRows.length === 0) {
      throw new MaisterError(
        "CONFIG",
        `flow ${flowId} is not configured for project`,
      );
    }
  }

  const taskId = randomUUID();

  // ADR-078 D1: number allocation + task insert in ONE transaction. The
  // projects-row lock (UPDATE … RETURNING) serializes concurrent creates;
  // UNIQUE(project_id, number) is the backstop.
  const { number, taskKey } = await _db.transaction(async (tx: any) => {
    const allocated = await tx
      .update(projects)
      .set({ nextTaskNumber: sql`${projects.nextTaskNumber} + 1` })
      .where(eq(projects.id, ctx.projectId))
      .returning({
        allocated: projects.nextTaskNumber,
        taskKey: projects.taskKey,
      });

    if (allocated.length === 0) {
      throw new MaisterError(
        "PRECONDITION",
        `project ${ctx.projectId} not found`,
      );
    }

    const allocatedNumber = (allocated[0].allocated as number) - 1;

    log.debug(
      { projectId: ctx.projectId, allocated: allocatedNumber },
      "task number allocated",
    );

    await tx.insert(tasks).values({
      id: taskId,
      projectId: ctx.projectId,
      number: allocatedNumber,
      title: input.title,
      prompt: input.prompt,
      flowId,
      createdByUserId: ctx.actorUserId ?? null,
      status: "Backlog",
      stage: "Backlog",
    });

    const actor = actorForUserId(ctx.actorUserId);

    await recordTaskActivity(tx, {
      taskId,
      projectId: ctx.projectId,
      actor,
      eventKind: "task_created",
      payload: {},
    });

    await emitDomainEvent({
      db: tx,
      kind: "task.created",
      projectId: ctx.projectId,
      taskId,
      actor,
      payload: {
        taskKey: `${allocated[0].taskKey as string}-${allocatedNumber}`,
        title: input.title,
      },
    });

    if (actor.type === "user") {
      await subscribe(tx, {
        taskId,
        subscriber: { type: "user", id: actor.id },
        reason: "creator",
      });
    }

    return {
      number: allocatedNumber,
      taskKey: allocated[0].taskKey as string,
    };
  });

  log.info(
    { projectId: ctx.projectId, taskId, flowId, taskKey, number },
    "task created",
  );

  return { taskId, number, taskKey };
}

export type TaskDTO = {
  id: string;
  number: number;
  taskKey: string;
  title: string;
  prompt: string;
  status: string;
  stage: string;
  flowId: string | null;
  // M34 launch-verdict fields (ADR-089): triage stamps them, the board's
  // launch popover edits them pre-launch.
  triageStatus: "triaged" | null;
  runnerId: string | null;
  targetBranch: string | null;
  promotionMode: "local_merge" | "pull_request" | null;
  latestRunId: string | null;
  attemptNumber: number;
  createdByUserId: string | null;
  createdAt: Date;
};

async function taskToDTO(row: any, db: { select: any }): Promise<TaskDTO> {
  const keyRows = await (db as any)
    .select({ taskKey: projects.taskKey })
    .from(projects)
    .where(eq(projects.id, row.projectId));
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
    number: row.number,
    taskKey: keyRows[0]?.taskKey ?? "",
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    stage: row.stage,
    flowId: row.flowId ?? null,
    triageStatus: row.triageStatus ?? null,
    runnerId: row.runnerId ?? null,
    targetBranch: row.targetBranch ?? null,
    promotionMode: row.promotionMode ?? null,
    latestRunId: runRows[0]?.id ?? null,
    attemptNumber: row.attemptNumber,
    createdByUserId: row.createdByUserId ?? null,
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
  flowId?: string | null;
  runnerId?: string | null;
  targetBranch?: string | null;
  promotionMode?: PromotionMode | null;
  executionPolicy?: ExecutionPolicy | null;
};

function updateColumns(input: UpdateTaskInput): Record<string, unknown> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (input.title !== undefined) patch.title = input.title;
  if (input.prompt !== undefined) patch.prompt = input.prompt;
  if (input.flowId !== undefined) patch.flowId = input.flowId;
  if (input.runnerId !== undefined) patch.runnerId = input.runnerId;
  if (input.targetBranch !== undefined) patch.targetBranch = input.targetBranch;
  if (input.promotionMode !== undefined) {
    patch.promotionMode = input.promotionMode;
  }
  if (input.executionPolicy !== undefined) {
    patch.executionPolicy = input.executionPolicy;
  }

  return patch;
}

function verdictPatch(input: UpdateTaskInput): TaskVerdictPatch {
  const patch: TaskVerdictPatch = {};

  if (input.flowId !== undefined) patch.flowId = input.flowId;
  if (input.runnerId !== undefined) patch.runnerId = input.runnerId;
  if (input.targetBranch !== undefined) patch.targetBranch = input.targetBranch;
  if (input.promotionMode !== undefined) {
    patch.promotionMode = input.promotionMode;
  }

  return patch;
}

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

  const patch = updateColumns(input);

  if (Object.keys(patch).length === 1) {
    throw new MaisterError("CONFIG", "at least one task field is required");
  }

  await validateVerdictRefs(projectId, verdictPatch(input), _db);

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
