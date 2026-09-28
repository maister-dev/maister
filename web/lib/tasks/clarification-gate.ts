import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { taskClarifications } from "@/lib/db/schema";

type Db = ReturnType<typeof getDb>;

export async function countOpenBlockingClarifications(
  taskId: string,
  db: Db = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskClarifications)
    .where(
      and(
        eq(taskClarifications.taskId, taskId),
        eq(taskClarifications.originKind, "user"),
        eq(taskClarifications.status, "open"),
        eq(taskClarifications.blocking, true),
      ),
    );

  return row?.count ?? 0;
}

export async function countOpenBlockingClarificationsByTask(
  taskIds: string[],
  db: Db = getDb(),
): Promise<Map<string, number>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select({
      taskId: taskClarifications.taskId,
      count: sql<number>`count(*)::int`,
    })
    .from(taskClarifications)
    .where(
      and(
        inArray(taskClarifications.taskId, taskIds),
        eq(taskClarifications.originKind, "user"),
        eq(taskClarifications.status, "open"),
        eq(taskClarifications.blocking, true),
      ),
    )
    .groupBy(taskClarifications.taskId);

  return new Map(rows.map((row) => [row.taskId, row.count]));
}
