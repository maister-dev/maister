import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { projects, taskClarifications, tasks } from "@/lib/db/schema";

type Db = ReturnType<typeof getDb>;

export type RecipientClarification = {
  id: string;
  taskId: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  taskKey: string;
  taskTitle: string;
  question: string;
  reason: string;
  answerFormat: "text" | "choice" | "yes_no";
  blocking: boolean;
  recipientUserId: string;
  requesterUserId: string;
  createdAt: Date;
};

export async function listOpenClarificationsForRecipient(
  userId: string,
  projectIds: string[],
  db: Db = getDb(),
): Promise<RecipientClarification[]> {
  if (projectIds.length === 0) return [];
  const rows = await db
    .select({
      id: taskClarifications.id,
      taskId: taskClarifications.taskId,
      projectId: tasks.projectId,
      projectSlug: projects.slug,
      projectName: projects.name,
      taskKey: projects.taskKey,
      taskNumber: tasks.number,
      taskTitle: tasks.title,
      question: taskClarifications.question,
      reason: taskClarifications.reason,
      answerFormat: taskClarifications.answerFormat,
      blocking: taskClarifications.blocking,
      recipientUserId: taskClarifications.recipientUserId,
      requesterUserId: taskClarifications.requesterUserId,
      createdAt: taskClarifications.createdAt,
    })
    .from(taskClarifications)
    .innerJoin(tasks, eq(tasks.id, taskClarifications.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(
      and(
        inArray(tasks.projectId, projectIds),
        eq(taskClarifications.originKind, "user"),
        eq(taskClarifications.status, "open"),
        eq(taskClarifications.recipientUserId, userId),
      ),
    );

  return rows.map((row) => ({
    ...row,
    taskKey: `${row.taskKey}-${row.taskNumber}`,
    requesterUserId: row.requesterUserId!,
    recipientUserId: row.recipientUserId!,
    reason: row.reason!,
    answerFormat: row.answerFormat!,
  }));
}
