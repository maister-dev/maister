import "server-only";

import type { Db } from "@/lib/execution-host/db";
import type { TaskLaunchInputSnapshot } from "./launch-types";

import { and, asc, eq } from "drizzle-orm";

import { projects, taskClarifications, tasks } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

/** Caller holds the task lock when freezing this input for acceptance or dispatch. */
export async function loadTaskSemanticInput(
  db: Db,
  projectId: string,
  taskId: string,
): Promise<{
  task: typeof tasks.$inferSelect;
  snapshot: TaskLaunchInputSnapshot;
}> {
  const [row] = await db
    .select({ task: tasks, defaultTarget: projects.mainBranch })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));

  if (!row)
    throw new MaisterError("PRECONDITION", "Task is missing from its project", {
      details: { reason: "qualification_task_missing", projectId, taskId },
    });
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
