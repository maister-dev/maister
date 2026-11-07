import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type {
  TaskLaunchInputSnapshot,
  TaskLaunchInputV1Snapshot,
  TaskLaunchInputV2Snapshot,
} from "./launch-types";

import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { projects, taskClarifications, tasks } from "@/lib/db/schema";
import {
  composeEffectivePrompt,
  orderedAnsweredClarifications,
  MAX_CLARIFICATIONS_IN_PROMPT,
} from "@/lib/tasks/clarifications";
import { MaisterError } from "@/lib/errors";

async function loadTaskInputOwner(
  db: Db,
  projectId: string,
  taskId: string,
): Promise<{ task: typeof tasks.$inferSelect; defaultTarget: string }> {
  const [row] = await db
    .select({ task: tasks, defaultTarget: projects.mainBranch })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));

  if (!row)
    throw new MaisterError("PRECONDITION", "Task is missing from its project", {
      details: { reason: "qualification_task_missing", projectId, taskId },
    });

  return row;
}

/** Caller holds the task lock when freezing this input for acceptance or dispatch. */
export async function loadTaskQualificationMaterial(
  db: Db,
  projectId: string,
  taskId: string,
): Promise<{
  task: typeof tasks.$inferSelect;
  snapshot: TaskLaunchInputV1Snapshot;
}> {
  const row = await loadTaskInputOwner(db, projectId, taskId);
  const clarifications = await db
    .select({
      id: taskClarifications.id,
      question: taskClarifications.question,
      status: taskClarifications.status,
      answer: taskClarifications.answer,
      answeredAt: taskClarifications.answeredAt,
      supersededAt: taskClarifications.supersededAt,
    })
    .from(taskClarifications)
    .where(
      and(
        eq(taskClarifications.taskId, taskId),
        eq(taskClarifications.blocking, true),
      ),
    )
    .orderBy(asc(taskClarifications.seq))
    .limit(1001);

  if (clarifications.length > 1000)
    throw new MaisterError(
      "PRECONDITION",
      "Task input exceeds the supported clarification bound",
      {
        details: {
          reason: "qualification_input_limit",
          projectId,
          taskId,
          maximum: 1000,
        },
      },
    );

  return {
    task: row.task,
    snapshot: {
      version: 1,
      projectId,
      taskId,
      number: row.task.number,
      title: row.task.title,
      prompt: row.task.prompt,
      statementRevision: row.task.statementRevision,
      sourceVersion: row.task.qualificationSourceVersion,
      target: row.task.baseBranch ?? row.defaultTarget,
      deliveryTarget: row.task.targetBranch ?? row.defaultTarget,
      clarifications: clarifications.map((item) => ({
        ...item,
        answeredAt: item.answeredAt?.toISOString() ?? null,
        supersededAt: item.supersededAt?.toISOString() ?? null,
      })),
    },
  };
}

/** Capture exactly the answered context projected into execution, including nonblocking answers. */
export async function loadTaskSemanticInput(
  db: Db,
  projectId: string,
  taskId: string,
): Promise<{
  task: typeof tasks.$inferSelect;
  snapshot: TaskLaunchInputV2Snapshot;
}> {
  const row = await loadTaskInputOwner(db, projectId, taskId);
  const history = await db
    .select({
      id: taskClarifications.id,
      seq: taskClarifications.seq,
      question: taskClarifications.question,
      status: taskClarifications.status,
      answer: taskClarifications.answer,
      answeredAt: taskClarifications.answeredAt,
      supersededAt: taskClarifications.supersededAt,
    })
    .from(taskClarifications)
    .where(
      and(
        eq(taskClarifications.taskId, taskId),
        isNotNull(taskClarifications.answeredAt),
        isNull(taskClarifications.supersededAt),
        isNotNull(taskClarifications.answer),
        sql`${taskClarifications.answer}<>'null'::jsonb`,
      ),
    )
    .orderBy(asc(taskClarifications.seq), asc(taskClarifications.id))
    .limit(MAX_CLARIFICATIONS_IN_PROMPT);
  const byId = new Map(history.map((item) => [item.id, item]));
  const clarifications = orderedAnsweredClarifications(history).map((item) => {
    const original = byId.get(item.id);

    if (!original)
      throw new MaisterError(
        "PRECONDITION",
        "Execution clarification projection has no source",
        {
          details: { reason: "launch_clarification_source_missing", taskId },
        },
      );

    return {
      ...original,
      question: item.question,
      answeredAt: original.answeredAt?.toISOString() ?? null,
      supersededAt: original.supersededAt?.toISOString() ?? null,
    };
  });

  return {
    task: row.task,
    snapshot: {
      version: 2,
      projectId,
      taskId,
      number: row.task.number,
      title: row.task.title,
      prompt: row.task.prompt,
      statementRevision: row.task.statementRevision,
      sourceVersion: row.task.qualificationSourceVersion,
      target: row.task.baseBranch ?? row.defaultTarget,
      deliveryTarget: row.task.targetBranch ?? row.defaultTarget,
      clarifications,
    },
  };
}

/** v1 did not capture execution clarifications; a live read cannot complete that old decision. */
export function taskLaunchEffectivePrompt(
  snapshot: TaskLaunchInputSnapshot,
): string {
  if (snapshot.version !== 2)
    throw new MaisterError(
      "PRECONDITION",
      "Accepted input needs compatibility review",
      {
        details: { reason: "launch_input_snapshot_incomplete" },
      },
    );

  return composeEffectivePrompt(
    snapshot.prompt,
    snapshot.clarifications.map((item) => ({
      id: item.id,
      seq: item.seq,
      question: item.question,
      answer: item.answer,
    })),
  );
}
