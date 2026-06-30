import "server-only";

import type { ExecutionPolicy } from "@/lib/runs/execution-policy";
import type { TaskPriority } from "@/lib/tasks/criticality";

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
import { applyQueueWriteFields } from "@/lib/tasks/queue-fields";

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
  // M39 (ADR-106): set ONLY for a task auto-created by an agent trigger. The
  // pair is the (agent_id, trigger_event_id) idempotency claim — a concurrent
  // at-least-once redelivery converges to ONE auto-task. Absent for a board
  // task (which carries no trigger and never conflicts).
  agentId?: string | null;
  triggerEventId?: number | null;
};

export type CreateTaskContext = {
  projectId: string;
  actorUserId?: string | null;
};

export async function createTask(
  input: CreateTaskInput,
  ctx: CreateTaskContext,
  db?: Db,
): Promise<{
  taskId: string;
  number: number;
  taskKey: string;
  // M39 (ADR-106): true when a concurrent trigger redelivery lost the
  // (agent_id, trigger_event_id) claim and this call REUSED the winner's task
  // (no new row/event). Always false for a board task. Callers that launch a run
  // off the auto-task use this to converge to the winner instead of double-launching.
  deduped: boolean;
}> {
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
  const created = await _db.transaction(async (tx: any) => {
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

    // M39 (ADR-106): onConflictDoNothing on the (agent_id, trigger_event_id)
    // partial-unique converges a CONCURRENT trigger redelivery to one auto-task.
    // A board task carries no trigger ⇒ never conflicts ⇒ always inserts. (The
    // SEQUENTIAL redelivery is already short-circuited by launchAgentRun's run
    // pre-check before createTask is reached.)
    const inserted = await tx
      .insert(tasks)
      .values({
        id: taskId,
        projectId: ctx.projectId,
        number: allocatedNumber,
        title: input.title,
        prompt: input.prompt,
        flowId,
        agentId: input.agentId ?? null,
        triggerEventId: input.triggerEventId ?? null,
        createdByUserId: ctx.actorUserId ?? null,
        status: "Backlog",
        stage: "Backlog",
      })
      .onConflictDoNothing()
      .returning({ id: tasks.id });

    if (inserted.length === 0) {
      // Lost the (agent_id, trigger_event_id) claim to a concurrent redelivery —
      // the winner already created the auto-task AND emitted task.created. Reuse
      // it; do NOT re-emit activity/event/subscribe. (The allocated number is
      // consumed — a rare KEY-N gap, acceptable.)
      const existing = await tx
        .select({ id: tasks.id, number: tasks.number })
        .from(tasks)
        .where(
          and(
            eq(tasks.agentId, input.agentId ?? null),
            eq(tasks.triggerEventId, input.triggerEventId ?? null),
          ),
        );

      if (!existing[0]) {
        throw new MaisterError(
          "CONFLICT",
          `task insert conflicted but no claim row found for agent ${input.agentId} / trigger ${input.triggerEventId}`,
        );
      }

      return {
        taskId: existing[0].id as string,
        number: existing[0].number as number,
        taskKey: allocated[0].taskKey as string,
        deduped: true,
      };
    }

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
      taskId,
      number: allocatedNumber,
      taskKey: allocated[0].taskKey as string,
      deduped: false,
    };
  });

  log.info(
    {
      projectId: ctx.projectId,
      taskId: created.taskId,
      flowId,
      taskKey: created.taskKey,
      number: created.number,
      deduped: created.deduped,
    },
    created.deduped ? "task trigger redelivery deduped" : "task created",
  );

  return {
    taskId: created.taskId,
    number: created.number,
    taskKey: created.taskKey,
    deduped: created.deduped,
  };
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
  // launch popover edits them pre-launch. ADR-112: `flagged` marks a confirmed
  // duplicate / triage-rejected intake (held — non-launchable until resolved).
  triageStatus: "triaged" | "flagged" | null;
  runnerId: string | null;
  baseBranch: string | null;
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
    baseBranch: row.baseBranch ?? null,
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
  baseBranch?: string | null;
  targetBranch?: string | null;
  promotionMode?: PromotionMode | null;
  executionPolicy?: ExecutionPolicy | null;
  // ADR-121: priority + advisory confidence are Backlog-gated (config) fields;
  // queuePaused is the status-agnostic pause valve (allowed while InFlight too).
  priority?: TaskPriority | null;
  triageConfidence?: number | null;
  queuePaused?: boolean;
};

// ADR-121: the Backlog-gated config fields. `queuePaused` is deliberately NOT
// here — the pause valve must work while a task is InFlight (to stop an
// auto-relaunch / dequeue a resume), so it bypasses the Backlog gate (INV-10).
const BACKLOG_GATED_FIELDS = [
  "title",
  "prompt",
  "flowId",
  "runnerId",
  "baseBranch",
  "targetBranch",
  "promotionMode",
  "executionPolicy",
  "priority",
  "triageConfidence",
] as const;

function hasBacklogGatedField(input: UpdateTaskInput): boolean {
  return BACKLOG_GATED_FIELDS.some((f) => input[f] !== undefined);
}

function updateColumns(input: UpdateTaskInput): Record<string, unknown> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (input.title !== undefined) patch.title = input.title;
  if (input.prompt !== undefined) patch.prompt = input.prompt;
  if (input.flowId !== undefined) patch.flowId = input.flowId;
  if (input.runnerId !== undefined) patch.runnerId = input.runnerId;
  if (input.baseBranch !== undefined) patch.baseBranch = input.baseBranch;
  if (input.targetBranch !== undefined) patch.targetBranch = input.targetBranch;
  if (input.promotionMode !== undefined) {
    patch.promotionMode = input.promotionMode;
  }
  if (input.executionPolicy !== undefined) {
    patch.executionPolicy = input.executionPolicy;
  }
  if (input.queuePaused !== undefined) patch.queuePaused = input.queuePaused;

  applyQueueWriteFields(input, patch);

  return patch;
}

function verdictPatch(input: UpdateTaskInput): TaskVerdictPatch {
  const patch: TaskVerdictPatch = {};

  if (input.flowId !== undefined) patch.flowId = input.flowId;
  if (input.runnerId !== undefined) patch.runnerId = input.runnerId;
  if (input.baseBranch !== undefined) patch.baseBranch = input.baseBranch;
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

  // ADR-121 (INV-10): the pause valve works while a task is InFlight (to dequeue
  // a resume / stop an auto-relaunch); config fields stay Backlog-gated. Terminal
  // tasks accept neither.
  if (task.status !== "Backlog" && hasBacklogGatedField(input)) {
    throw new MaisterError(
      "PRECONDITION",
      `task is not in Backlog (got ${task.status})`,
    );
  }

  if (
    input.queuePaused !== undefined &&
    task.status !== "Backlog" &&
    task.status !== "InFlight"
  ) {
    throw new MaisterError(
      "PRECONDITION",
      `task is terminal (got ${task.status}); cannot change pause`,
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
